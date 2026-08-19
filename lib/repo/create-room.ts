import "server-only";

import { tryDb, withTransaction } from "@/lib/db";

export const WORKFLOW_STEPS = [
  "idea_vocab",
  "title",
  "thumbnail",
  "outline",
  "script",
  "review",
  "ready",
  "published",
] as const;

export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];
export type CandidateType = "idea_vocab" | "title" | "thumbnail";
export type CandidateStatus = "proposed" | "selected" | "rejected" | "archived";

export type CreateRoomEpisode = {
  id: string;
  threadId: string;
  episodeCode: string;
  workingTitle: string | null;
  workflowStep: WorkflowStep;
  selectedIdea: string | null;
  targetLearnerLevel: string | null;
  selectedTitle: string | null;
  selectedThumbnailConcept: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRoomCandidate = {
  id: string;
  episodeId: string;
  type: CandidateType;
  payload: Record<string, unknown>;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
};

type RawEpisode = {
  id: string;
  thread_id: string;
  episode_code: string;
  working_title: string | null;
  workflow_step: WorkflowStep;
  selected_idea: string | null;
  target_learner_level: string | null;
  selected_title: string | null;
  selected_thumbnail_concept: string | null;
  created_at: Date;
  updated_at: Date;
};
type RawCandidate = {
  id: string;
  episode_id: string;
  type: CandidateType;
  payload_json: Record<string, unknown>;
  status: CandidateStatus;
  created_at: Date;
  updated_at: Date;
};

const EPISODE_COLUMNS = `id, thread_id, episode_code, working_title, workflow_step,
  selected_idea, target_learner_level, selected_title, selected_thumbnail_concept,
  created_at, updated_at`;

function toEpisode(row: RawEpisode): CreateRoomEpisode {
  return {
    id: row.id,
    threadId: row.thread_id,
    episodeCode: row.episode_code,
    workingTitle: row.working_title,
    workflowStep: row.workflow_step,
    selectedIdea: row.selected_idea,
    targetLearnerLevel: row.target_learner_level,
    selectedTitle: row.selected_title,
    selectedThumbnailConcept: row.selected_thumbnail_concept,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
function toCandidate(row: RawCandidate): CreateRoomCandidate {
  return {
    id: row.id,
    episodeId: row.episode_id,
    type: row.type,
    payload: row.payload_json,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listEpisodes(): Promise<CreateRoomEpisode[]> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawEpisode>(
      `SELECT ${EPISODE_COLUMNS} FROM create_room_episodes ORDER BY updated_at DESC LIMIT 200`,
    );
    return rows.map(toEpisode);
  }, []);
}

export async function getEpisode(id: string): Promise<CreateRoomEpisode | null> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawEpisode>(
      `SELECT ${EPISODE_COLUMNS} FROM create_room_episodes WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? toEpisode(rows[0]) : null;
  }, null);
}

export async function createEpisode(input: {
  workingTitle?: string | null;
  modelId?: string | null;
}): Promise<CreateRoomEpisode> {
  return withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('create_room_episode_code'))");
    const codeResult = await c.query<{ next_number: number }>(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(episode_code, '\\D', '', 'g'), '')::int), 0) + 1 AS next_number
       FROM create_room_episodes`,
    );
    const episodeCode = `LCB-${String(codeResult.rows[0]?.next_number ?? 1).padStart(3, "0")}`;
    const title = input.workingTitle?.trim() || `New episode ${episodeCode}`;
    const threadResult = await c.query<{ id: string }>(
      `INSERT INTO threads (title, model_id) VALUES ($1, $2) RETURNING id`,
      [title, input.modelId ?? null],
    );
    const { rows } = await c.query<RawEpisode>(
      `INSERT INTO create_room_episodes (thread_id, episode_code, working_title, workflow_step)
       VALUES ($1, $2, $3, 'title') RETURNING ${EPISODE_COLUMNS}`,
      [threadResult.rows[0].id, episodeCode, title],
    );
    return toEpisode(rows[0]);
  });
}

export async function listCandidates(episodeId: string): Promise<CreateRoomCandidate[]> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawCandidate>(
      `SELECT id, episode_id, type, payload_json, status, created_at, updated_at
       FROM create_room_candidates WHERE episode_id = $1 ORDER BY created_at ASC`,
      [episodeId],
    );
    return rows.map(toCandidate);
  }, []);
}

export type TitleCandidateInput = { title: string; rationale: string; style: string };

export async function saveTitleCandidates(
  episodeId: string,
  candidates: TitleCandidateInput[],
): Promise<CreateRoomCandidate[]> {
  return withTransaction(async (c) => {
    const exists = await c.query(`SELECT 1 FROM create_room_episodes WHERE id = $1 FOR UPDATE`, [
      episodeId,
    ]);
    if (!exists.rowCount) throw new Error("episode_not_found");
    await c.query(
      `UPDATE create_room_candidates SET status = 'archived' WHERE episode_id = $1 AND type = 'title' AND status = 'proposed'`,
      [episodeId],
    );
    const out: CreateRoomCandidate[] = [];
    for (const candidate of candidates) {
      const { rows } = await c.query<RawCandidate>(
        `INSERT INTO create_room_candidates (episode_id, type, payload_json)
         VALUES ($1, 'title', $2::jsonb)
         RETURNING id, episode_id, type, payload_json, status, created_at, updated_at`,
        [episodeId, JSON.stringify(candidate)],
      );
      out.push(toCandidate(rows[0]));
    }
    return out;
  });
}

export async function selectCandidate(input: {
  episodeId: string;
  candidateId: string;
}): Promise<{ episode: CreateRoomEpisode; candidate: CreateRoomCandidate }> {
  return withTransaction(async (c) => {
    const candidateResult = await c.query<RawCandidate>(
      `SELECT id, episode_id, type, payload_json, status, created_at, updated_at
       FROM create_room_candidates WHERE id = $1 AND episode_id = $2 FOR UPDATE`,
      [input.candidateId, input.episodeId],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) throw new Error("candidate_not_found");
    await c.query(
      `UPDATE create_room_candidates SET status = CASE WHEN id = $2 THEN 'selected' ELSE 'archived' END WHERE episode_id = $1 AND type = $3`,
      [input.episodeId, input.candidateId, candidate.type],
    );
    await c.query(
      `INSERT INTO create_room_decisions (episode_id, decision_type, candidate_id, payload_json) VALUES ($1, $2, $3, $4::jsonb)`,
      [input.episodeId, candidate.type, candidate.id, JSON.stringify(candidate.payload_json)],
    );
    if (candidate.type === "title") {
      await c.query(
        `UPDATE create_room_episodes SET selected_title = $2, working_title = $2, workflow_step = 'thumbnail' WHERE id = $1`,
        [input.episodeId, String(candidate.payload_json.title ?? "Selected title")],
      );
      await c.query(
        `INSERT INTO messages (thread_id, role, content, parts)
         SELECT thread_id, 'assistant', $2, $3::jsonb
         FROM create_room_episodes WHERE id = $1`,
        [
          input.episodeId,
          `Selected title: ${String(candidate.payload_json.title ?? "Selected title")}. Moving this episode to Thumbnail.`,
          JSON.stringify([
            {
              type: "text",
              text: `Selected title: ${String(candidate.payload_json.title ?? "Selected title")}. Moving this episode to Thumbnail.`,
            },
          ]),
        ],
      );
    }
    const episodeResult = await c.query<RawEpisode>(
      `SELECT ${EPISODE_COLUMNS} FROM create_room_episodes WHERE id = $1`,
      [input.episodeId],
    );
    candidate.status = "selected";
    return { episode: toEpisode(episodeResult.rows[0]), candidate: toCandidate(candidate) };
  });
}
