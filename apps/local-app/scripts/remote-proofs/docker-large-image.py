#!/usr/bin/env python3
"""Create only the disposable >4-GiB random layer, streaming tar into Docker import."""
import json
import subprocess
import tarfile
import time

name = 'dc-large-ffe78fcf:proof'
if subprocess.run(['sudo','-n','docker','image','inspect',name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
    raise SystemExit('Proof image already exists; inspect and remove it before rerunning')
size = 4 * 1024**3 + 16 * 1024**2
started = time.monotonic()
process = subprocess.Popen(['sudo','-n','docker','import','--change','LABEL devchain.proof=ffe78fcf','-',name], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
try:
    with tarfile.open(fileobj=process.stdin, mode='w|') as archive:
        entry = tarfile.TarInfo('payload')
        entry.size = size
        entry.mode = 0o600
        with open('/dev/urandom','rb') as random:
            archive.addfile(entry, random)
    process.stdin.close()
    image_id = process.stdout.read().decode().strip()
    if process.wait() != 0:
        raise SystemExit('Docker import failed')
    print(json.dumps({'case':'large-image-created','payloadBytes':size,'image':name,'imageId':image_id,'seconds':time.monotonic()-started,'temporaryTarFiles':0}),flush=True)
finally:
    if process.poll() is None:
        process.terminate()
