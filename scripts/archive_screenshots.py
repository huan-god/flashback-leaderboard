#!/usr/bin/env python3
"""Archive Supabase screenshots >24h into private ZIPs, expire ZIPs >7d.
Requires: pip install requests
"""
import os, io, sys, json, hashlib, zipfile, tempfile, time
from datetime import datetime, timezone, timedelta
from urllib.parse import quote
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SOURCES = ("proofs", "mane-proofs")
ARCHIVE = "screenshot-archives"
DRY_RUN = os.getenv("DRY_RUN", "true").lower() != "false"
# Free tier upload limit is 50 MiB. Conservative raw limit per zip.
CHUNK_BYTES = int(os.getenv("CHUNK_BYTES", str(35 * 1024 * 1024)))
UTC = timezone.utc

session = requests.Session()
session.headers.update({"apikey": KEY})

if not KEY.startswith("sb_secret_"):
    session.headers["Authorization"] = f"Bearer {KEY}"
retries = Retry(total=4, backoff_factor=1, status_forcelist=[429,500,502,503,504],
                allowed_methods=frozenset(["GET","POST","PUT","DELETE"]))
session.mount("https://", HTTPAdapter(max_retries=retries))

def req(method, url, **kw):
    r = session.request(method, url, timeout=(15, 180), **kw)
    r.raise_for_status()
    return r

def objurl(bucket, name):
    return f"{BASE}/storage/v1/object/{quote(bucket,safe='')}/{quote(name,safe='/')}"

def list_dir(bucket, prefix=""):
    offset = 0
    while True:
        data = req("POST", f"{BASE}/storage/v1/object/list/{quote(bucket)}",
                   json={"prefix": prefix, "limit":1000, "offset":offset,
                         "sortBy":{"column":"name","order":"asc"}}).json()
        for row in data:
            if row.get("id") is None:
                yield from list_dir(bucket, f"{prefix}{row['name']}/")
            else:
                yield {"bucket":bucket, "name":prefix+row["name"],
                       "created_at":row["created_at"],
                       "size":int((row.get("metadata") or {}).get("size") or 0)}
        if len(data)<1000: break
        offset+=len(data)

def date(s):
    return datetime.fromisoformat(s.replace("Z","+00:00")).astimezone(UTC)

def remove(bucket, paths):
    for i in range(0,len(paths),1000):
        payload={"prefixes":paths[i:i+1000]}
        req("DELETE", f"{BASE}/storage/v1/object/{quote(bucket)}", json=payload)

def download(bucket, name):
    return req("GET",objurl(bucket,name)).content

def upload(name, payload):
    return req("POST",objurl(ARCHIVE,name),
               headers={"Content-Type":"application/zip","x-upsert":"false"},
               data=payload)

def chunks(rows):
    current=[]; size=0
    for row in rows:
        n=max(row["size"],1)
        if current and size+n>CHUNK_BYTES:
            yield current
            current=[];size=0
        current.append(row); size+=n
    if current: yield current

def make_zip(rows):
    buf=io.BytesIO()
    manifest=[]
    with zipfile.ZipFile(buf,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
        for item in rows:
            data=download(item["bucket"],item["name"])
            stored=f'{item["bucket"]}/{item["name"]}'
            z.writestr(stored,data)
            manifest.append({"bucket":item["bucket"],"name":item["name"],
                             "created_at":item["created_at"],"bytes":len(data),
                             "sha256":hashlib.sha256(data).hexdigest()})
        z.writestr("manifest.json",json.dumps(manifest,ensure_ascii=False,indent=2))
    return buf.getvalue(), manifest

def main():
    now=datetime.now(UTC)
    cutoff=now-timedelta(hours=24)
    oldzip=now-timedelta(days=7)
    rows=sorted((x for b in SOURCES for x in list_dir(b)
                 if date(x["created_at"]) <= cutoff),
                key=lambda x:(x["created_at"],x["bucket"],x["name"]))
    print(f"Eligible originals: {len(rows)}; dry_run={DRY_RUN}",flush=True)
    if DRY_RUN:
        print(json.dumps({"sample":rows[:10]},ensure_ascii=False,indent=2))
    else:
        for idx,group in enumerate(chunks(rows),1):
            # Unique per run, prevents accidental overwrites
            name=f'{now:%Y/%m/%d}/{now:%Y%m%dT%H%M%S%fZ}-part{idx:04d}.zip'
            content, manifest=make_zip(group)
            print(f"Uploading {name}: {len(group)} files, {len(content)} bytes",flush=True)
            # Free projects cap upload at 50MB. Stop rather than delete.
            if len(content)>49*1024*1024:
                raise RuntimeError(f"ZIP too big for Free storage limit: {name}")
            upload(name,content)
            # Verify the copy stored in Supabase before any deletion
            reread=download(ARCHIVE,name)
            if hashlib.sha256(reread).digest()!=hashlib.sha256(content).digest():
                raise RuntimeError("Archive verification failed; originals preserved")
            with zipfile.ZipFile(io.BytesIO(reread)) as check:
                assert check.testzip() is None
                assert len(json.loads(check.read("manifest.json")))==len(manifest)
            # Remove originals via Storage API. Group by bucket.
            for bucket in SOURCES:
                names=[x["name"] for x in group if x["bucket"]==bucket]
                if names: remove(bucket,names)
            print(f"Archived and removed {len(group)} originals",flush=True)
    # Archive expiry applies only to ZIP creation time, never original upload time.
    expired=[x["name"] for x in list_dir(ARCHIVE) if date(x["created_at"])<=oldzip]
    print(f"Expired ZIPs (>7d since archive upload): {len(expired)}",flush=True)
    if not DRY_RUN and expired:
        remove(ARCHIVE,expired)
    print("Done.",flush=True)

if __name__=="__main__":
    main()
