#!/usr/bin/env python3
"""One image -> one ZIP after 24h. Delete each ZIP after 7d.
Uses Supabase Storage API; original is deleted only after verified archive upload.
"""
import hashlib
import io
import json
import os
import zipfile
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SOURCES = ("proofs", "mane-proofs")
ARCHIVE = "screenshot-archives"
DRY_RUN = os.getenv("DRY_RUN", "true").lower() != "false"
UTC = timezone.utc

session = requests.Session()
session.headers.update({"apikey": KEY})
if not KEY.startswith("sb_secret_"):
    session.headers["Authorization"] = f"Bearer {KEY}"
retry = Retry(total=4, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504],
              allowed_methods=frozenset(("GET", "POST", "PUT", "DELETE")))
session.mount("https://", HTTPAdapter(max_retries=retry))


def req(method, url, **kw):
    response = session.request(method, url, timeout=(15, 180), **kw)
    response.raise_for_status()
    return response


def object_url(bucket, name):
    return f"{BASE}/storage/v1/object/{quote(bucket, safe='')}/{quote(name, safe='/')}"


def objects(bucket, prefix=""):
    offset = 0
    while True:
        data = req("POST", f"{BASE}/storage/v1/object/list/{quote(bucket)}",
                   json={"prefix": prefix, "limit": 1000, "offset": offset,
                         "sortBy": {"column": "name", "order": "asc"}}).json()
        for row in data:
            if row.get("id") is None:
                yield from objects(bucket, prefix + row["name"] + "/")
            else:
                yield {"bucket": bucket, "name": prefix + row["name"],
                       "created_at": row["created_at"]}
        if len(data) < 1000:
            return
        offset += len(data)


def parsed_datetime(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def download(bucket, name):
    return req("GET", object_url(bucket, name)).content


def upload(name, content):
    req("POST", object_url(ARCHIVE, name),
        headers={"Content-Type": "application/zip", "x-upsert": "false"},
        data=content)


def delete(bucket, names):
    for i in range(0, len(names), 1000):
        req("DELETE", f"{BASE}/storage/v1/object/{quote(bucket)}",
            json={"prefixes": names[i:i+1000]})


def make_zip(item):
    original = download(item["bucket"], item["name"])
    archive = io.BytesIO()
    inside_name = item["name"].split("/")[-1]
    manifest = {"bucket": item["bucket"], "path": item["name"],
                "created_at": item["created_at"], "size": len(original),
                "sha256": hashlib.sha256(original).hexdigest()}
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr(inside_name, original)
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return archive.getvalue(), manifest, inside_name


def main():
    now = datetime.now(UTC)
    cutoff = now - timedelta(hours=24)
    expire_before = now - timedelta(days=7)
    candidates = sorted((item for bucket in SOURCES for item in objects(bucket)
                         if parsed_datetime(item["created_at"]) <= cutoff),
                        key=lambda item: (item["created_at"], item["bucket"], item["name"]))
    print(f"Eligible originals: {len(candidates)}; dry_run={DRY_RUN}", flush=True)
    if DRY_RUN:
        print(json.dumps(candidates[:10], ensure_ascii=False, indent=2), flush=True)
    else:
        for number, item in enumerate(candidates, 1):
            # One ZIP per image. Paths retain bucket and user folder to make lookup easy.
            zip_path = f"{now:%Y/%m/%d}/{item['bucket']}/{item['name']}.zip"
            content, manifest, inside_name = make_zip(item)
            if len(content) > 49 * 1024 * 1024:
                raise RuntimeError(f"ZIP >49 MiB (original preserved): {item['name']}")
            print(f"Uploading {zip_path}: 1 file, {len(content)} bytes", flush=True)
            upload(zip_path, content)
            reread = download(ARCHIVE, zip_path)
            if hashlib.sha256(reread).digest() != hashlib.sha256(content).digest():
                raise RuntimeError(f"ZIP verification failed (original preserved): {zip_path}")
            with zipfile.ZipFile(io.BytesIO(reread)) as z:
                if z.testzip() is not None or json.loads(z.read("manifest.json")) != manifest:
                    raise RuntimeError(f"ZIP contents invalid (original preserved): {zip_path}")
                if hashlib.sha256(z.read(inside_name)).hexdigest() != manifest["sha256"]:
                    raise RuntimeError(f"Image checksum mismatch: {zip_path}")
            delete(item["bucket"], [item["name"]])
            print(f"Archived and removed 1 original ({number}/{len(candidates)}): {item['name']}", flush=True)

    expired = [item["name"] for item in objects(ARCHIVE)
               if parsed_datetime(item["created_at"]) <= expire_before]
    print(f"Expired ZIPs (>7d since archive upload): {len(expired)}", flush=True)
    if not DRY_RUN and expired:
        delete(ARCHIVE, expired)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
