#!/usr/bin/env python3
"""Dependency-free Control Room OTel config merge and archive inspection."""
import argparse, datetime as dt, json, os, re, socket, subprocess, sys, tempfile, urllib.request
try:
    import tomllib
except ImportError:
    tomllib = None
from pathlib import Path

HOME = Path(os.environ.get("CONTROL_ROOM_OTEL_HOME", Path.home()/"Library/Application Support/ControlRoom/otel"))
CODEX = Path.home()/".codex/config.toml"
BLOCK = '''[otel]\nenvironment = "mac-local"\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }\ntrace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "binary" } }\nmetrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "binary" } }\n'''

def valid_toml(text):
    if tomllib is not None:
        try: tomllib.loads(text); return True
        except Exception: return False
    for l in text.splitlines():
        if re.match(r'^[+@>]',l): return False
    return text.count('[')==text.count(']')

def atomic_write(path,data):
    fd,tmp=tempfile.mkstemp(dir=str(path.parent),prefix=path.name+'.',suffix='.tmp')
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        mode=path.stat().st_mode if path.exists() else 0o600
        os.chmod(tmp,mode)
        os.replace(tmp,str(path))
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def corrupt_otel(text):
    lines,start,end=otel_range(text)
    if start is None: return False
    return any(re.match(r'^[+@>]',l) for l in lines[start:end])

def list_backups(path):
    return sorted(path.parent.glob(path.name+'.backup-*'),reverse=True)

def rollback(path,backup=None,list_only=False):
    backups=list_backups(path)
    if list_only:
        for b in backups: print(b.name)
        return 0
    if not backups: raise SystemExit("no timestamped backups found for %s" % path)
    chosen=path.parent/backup if backup else backups[0]
    if backup and chosen not in backups: raise SystemExit("backup not found: %s" % backup)
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    if path.exists():
        snap=path.with_name(path.name+'.pre-rollback-'+stamp); snap.write_bytes(path.read_bytes())
    atomic_write(path,chosen.read_bytes())
    print("restored %s from %s" % (path,chosen.name))
    return 0

def otel_range(text):
    lines=text.splitlines(True); start=None
    for i,l in enumerate(lines):
        if re.match(r'^\[otel(?:\.|\])',l):
            if start is None: start=i
        elif start is not None and l.startswith('['): return lines,start,i
    return lines,start,len(lines)

def configure(path):
    text=path.read_text() if path.exists() else ""
    lines,start,end=otel_range(text)
    if start is not None:
        existing=''.join(lines[start:end]).strip()
        if existing == BLOCK.strip(): return False
        if corrupt_otel(text):
            merged=''.join(lines[:start])+BLOCK+''.join(lines[end:])
        else:
            raise SystemExit("conflicting existing [otel] configuration; refusing to overwrite")
    else:
        merged=text.rstrip()+"\n\n"+BLOCK
    if not valid_toml(merged):
        raise SystemExit("generated config.toml failed TOML validation; nothing written (%s)" % path)
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    if path.exists(): path.with_name(path.name+'.backup-'+stamp).write_bytes(path.read_bytes())
    atomic_write(path,merged.encode())
    return True

def prom():
    try: return urllib.request.urlopen('http://127.0.0.1:8888/metrics',timeout=2).read().decode()
    except Exception: return ''

def metric(body,name,signal=None):
    total=0.0
    for line in body.splitlines():
        if line.startswith(name+('{' if '{' in line else ' ')):
            if signal and ('type="%s"'%signal not in line and 'data_type="%s"'%signal not in line): continue
            try: total += float(line.rsplit(' ',1)[1])
            except Exception: pass
    return int(total)

def archives(since):
    cutoff=dt.datetime.now(dt.timezone.utc).timestamp()-since
    out={s:{'files':0,'records':0,'malformed':0,'items':0,'missing_ids':0,'first':None,'last':None} for s in ('logs','traces','metrics')}
    keys={'logs':'resourceLogs','traces':'resourceSpans','metrics':'resourceMetrics'}
    for sig in out:
        for p in (HOME/'data'/sig).glob('*.json*') if (HOME/'data'/sig).exists() else []:
            if p.stat().st_mtime < cutoff: continue
            out[sig]['files']+=1
            for line in p.open(errors='replace'):
                try: obj=json.loads(line); out[sig]['records']+=1
                except Exception: out[sig]['malformed']+=1; continue
                def walk(x):
                    if isinstance(x,dict):
                        for k,v in x.items():
                            if k in ('timeUnixNano','startTimeUnixNano','endTimeUnixNano'):
                                try:
                                    z=dt.datetime.fromtimestamp(int(v)/1e9,dt.timezone.utc).isoformat()
                                    out[sig]['first']=min(filter(None,[out[sig]['first'],z])); out[sig]['last']=max(filter(None,[out[sig]['last'],z]))
                                except Exception: pass
                            walk(v)
                    elif isinstance(x,list):
                        for v in x: walk(v)
                walk(obj)
                root=obj.get(keys[sig],[]); out[sig]['items'] += len(root)
                if sig=='traces':
                    raw=line.lower(); out[sig]['missing_ids'] += int('traceid' not in raw or 'spanid' not in raw)
    return out

def configured():
    if not CODEX.exists(): return False
    t=CODEX.read_text(errors='replace')
    return '[otel]' in t and '127.0.0.1:4318' in t and 'log_user_prompt = false' in t

def report(since=3600):
    body=prom(); arc=archives(since)
    running=False
    try: running=subprocess.run(['launchctl','print','gui/%d/com.controlroom.otelcol'%os.getuid()],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    except Exception: pass
    version='unknown'
    b=HOME/'bin/otelcol-contrib'
    if b.exists():
        try: version=subprocess.check_output([b,'--version'],text=True,stderr=subprocess.STDOUT).strip()
        except Exception: pass
    data={
      'state':'FAILED','collector_running':running,'collector_version':version,
      'endpoints':{'otlp_grpc':'127.0.0.1:4317','otlp_http':'127.0.0.1:4318','metrics':'127.0.0.1:8888','health':'127.0.0.1:13133'},
      'capture_node_id':(HOME/'state/capture_node_id').read_text().strip() if (HOME/'state/capture_node_id').exists() else None,
      'archive':str(HOME/'data'),'archive_bytes':sum(p.stat().st_size for p in (HOME/'data').rglob('*') if p.is_file()) if (HOME/'data').exists() else 0,
      'codex_configured':configured(),'signals':arc,
      'collector':{
        'accepted_logs':metric(body,'otelcol_receiver_accepted_log_records'),
        'accepted_spans':metric(body,'otelcol_receiver_accepted_spans'),
        'accepted_metric_points':metric(body,'otelcol_receiver_accepted_metric_points'),
        'refused_logs':metric(body,'otelcol_receiver_refused_log_records'),
        'refused_spans':metric(body,'otelcol_receiver_refused_spans'),
        'refused_metric_points':metric(body,'otelcol_receiver_refused_metric_points'),
        'exported_logs':metric(body,'otelcol_exporter_sent_log_records'),
        'exported_spans':metric(body,'otelcol_exporter_sent_spans'),
        'exported_metric_points':metric(body,'otelcol_exporter_sent_metric_points'),
        'export_failed_logs':metric(body,'otelcol_exporter_send_failed_log_records'),
        'export_failed_spans':metric(body,'otelcol_exporter_send_failed_spans'),
        'export_failed_metric_points':metric(body,'otelcol_exporter_send_failed_metric_points'),
        'enqueue_failed_logs':metric(body,'otelcol_exporter_enqueue_failed_log_records'),
        'enqueue_failed_spans':metric(body,'otelcol_exporter_enqueue_failed_spans'),
        'enqueue_failed_metric_points':metric(body,'otelcol_exporter_enqueue_failed_metric_points')},
    }
    malformed=sum(x['malformed'] for x in arc.values()); activity=sum(x['records'] for x in arc.values())
    failures=sum(data['collector'][k] for k in data['collector'] if 'failed' in k or 'refused' in k)
    data['state']='FAILED' if not running or not body else ('DEGRADED' if failures or malformed else ('HEALTHY' if activity else 'NO ACTIVITY'))
    return data

def human(d,status=False):
    print('Collector:', 'running' if d['collector_running'] else 'not running'); print('Version:',d['collector_version'])
    print('Endpoints:',', '.join(d['endpoints'].values())); print('capture_node_id:',d['capture_node_id']); print('Archive:',d['archive'],'(%d bytes)'%d['archive_bytes']); print('Codex OTel configured:',d['codex_configured'])
    for s,x in d['signals'].items(): print('%s: files=%d records=%d groups=%d malformed=%d first=%s last=%s'%(s,x['files'],x['records'],x['items'],x['malformed'],x['first'],x['last']))
    if not status: print('Collector integrity:', ' '.join('%s=%s'%x for x in d['collector'].items()))
    print(d['state'])

def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    c=sub.add_parser('configure'); c.add_argument('--path',type=Path,default=CODEX)
    r=sub.add_parser('rollback'); r.add_argument('--path',type=Path,default=CODEX); r.add_argument('--backup'); r.add_argument('--list',action='store_true')
    for n in ('status','check'):
        q=sub.add_parser(n); q.add_argument('--json',action='store_true'); q.add_argument('--since',default='1h')
    a=p.parse_args()
    if a.cmd=='configure': print('changed' if configure(a.path) else 'unchanged'); return
    if a.cmd=='rollback': sys.exit(rollback(a.path,a.backup,a.list))
    m=re.fullmatch(r'(\d+)([smhd])',a.since); secs=int(m.group(1))*{'s':1,'m':60,'h':3600,'d':86400}[m.group(2)] if m else 3600
    d=report(secs); print(json.dumps(d,indent=2) if a.json else '');
    if not a.json: human(d,a.cmd=='status')
    if a.cmd=='check' and d['state'] in ('FAILED','DEGRADED'): sys.exit(1)
if __name__=='__main__': main()
