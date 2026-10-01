#!/usr/bin/env python3
"""Two-engine proof using an explicitly supplied SSH target after its owner releases it.

Run: python3 docker-roundtrip-proof.py ngsupb@192.168.1.100
Only synthetic resources under the unique prefix are created and removed.
"""
import io
import json
import pathlib
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time

if len(sys.argv) != 2:
    raise SystemExit('Expected authorized SSH user@host; do not run before target handoff')
target = sys.argv[1]
prefix = 'dc-roundtrip-ffe78fcf'
label = 'devchain.proof=ffe78fcf'
root = pathlib.Path(tempfile.mkdtemp(prefix=prefix))
image = prefix + ':offline'
resources = {'home': {'containers': [], 'volumes': [], 'networks': []}, 'vm': {'containers': [], 'volumes': [], 'networks': []}}
version = None
initialized = []
created_volumes = {}
protected_volumes = {}


def argv(side, args):
    return list(args) if side == 'home' else ['ssh', '-i', '/home/ngsupb/.ssh/id_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', target, shlex.join(args)]


def run(side, *args, data=None, check=True):
    return subprocess.run(argv(side, args), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)


def docker(side, *args):
    return run(side, 'sudo', '-n', 'docker', *args).stdout.decode().strip()


def api(side, method, path, body=None):
    args = ['sudo', '-n', 'curl', '--fail-with-body', '-sS', '--unix-socket', '/var/run/docker.sock', '-X', method]
    if body is not None:
        content = 'application/json' if isinstance(body, dict) else 'application/x-tar'
        args += ['-H', 'Content-Type: ' + content, '--data-binary', '@-']
        if isinstance(body, dict):
            body = json.dumps(body).encode()
    return run(side, *args, 'http://localhost' + ('/v' + version if version else '') + path, data=body).stdout


def emit(case, **values):
    print(json.dumps({'case': case, **values}), flush=True)


def inspect(side, name):
    return json.loads(docker(side, 'inspect', name))[0]


def remember(side, kind, name):
    if name not in resources[side][kind]:
        resources[side][kind].append(name)


def create(side, name, *args):
    before = set(docker(side,'volume','ls','-q').splitlines())
    docker(side, 'create', '--name', name, '--label', label, *args)
    remember(side, 'containers', name)
    mounts = [m['Name'] for m in inspect(side,name)['Mounts'] if m['Type']=='volume']
    created_volumes[(side,name)] = [v for v in mounts if v not in before]
    protected_volumes[(side,name)] = [v for v in mounts if v in before]
    for volume in created_volumes[(side,name)]: remember(side,'volumes',volume)
    emit('container-mount-inventory', side=side, container=name, newlyCreatedVolumes=created_volumes[(side,name)], protectedExistingVolumes=[v for v in mounts if v in before])
    return name


def remove_container(side, name):
    docker(side, 'rm', '-f', name)
    removed=[]
    for volume in created_volumes.get((side,name),[]):
        docker(side,'volume','rm',volume)
        removed.append(volume)
    for volume in protected_volumes.get((side,name),[]):
        docker(side,'volume','inspect',volume)
    emit('container-owned-volume-cleanup', side=side, container=name, removed=removed, protectedStillPresent=protected_volumes.get((side,name),[]))


def metadata(data):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        return [(m.name, m.uid, m.gid, m.mode, m.linkname, m.size) for m in archive.getmembers()]


def copy_mount(source_side, dest_side, mount, dest_name, counter):
    source = mount['Source'] if mount['Type'] == 'bind' else mount['Name']
    if mount['Type'] == 'volume':
        remember(dest_side, 'volumes', dest_name)
        docker(dest_side, 'volume', 'create', '--label', label, dest_name)
    reader = create(source_side, prefix + '-read-' + str(counter), '-v', source + ':/payload:ro', image, 'true')
    writer = create(dest_side, prefix + '-write-' + str(counter), '-v', dest_name + ':/payload', image, 'true')
    archive = api(source_side, 'GET', '/containers/' + reader + '/archive?path=/payload')
    api(dest_side, 'PUT', '/containers/' + writer + '/archive?copyUIDGID=true&path=/', archive)
    restored = api(dest_side, 'GET', '/containers/' + writer + '/archive?path=/payload')
    assert metadata(archive) == metadata(restored)
    emit('archive-transfer', direction=source_side + '-' + dest_side, type=mount['Type'], metadataEqual=True, bytes=len(archive), helpersStopped=inspect(source_side,reader)['State']['Status']=='created' and inspect(dest_side,writer)['State']['Status']=='created')
    remove_container(source_side, reader)
    remove_container(dest_side, writer)


def wait_pg(side, name):
    for _ in range(120):
        if run(side, 'sudo', '-n', 'docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', check=False).returncode == 0:
            return
        time.sleep(.25)
    raise RuntimeError('Postgres readiness timeout')


def sql(side, name, query):
    return docker(side, 'exec', name, 'psql', '-U', 'postgres', '-tAc', query)


try:
    for side in ['home', 'vm']:
        for kind, args in [('containers', ['ps','-aq','--filter','name='+prefix]), ('volumes', ['volume','ls','-q','--filter','name='+prefix]), ('networks', ['network','ls','-q','--filter','name='+prefix]), ('images', ['image','ls','-q',image])]:
            if docker(side, *args):
                raise RuntimeError('Pre-existing proof ' + kind + ' on ' + side + '; inspect before rerunning')
    initialized = ['home', 'vm']
    versions = [json.loads(api(side, 'GET', '/version')) for side in ['home', 'vm']]
    key = lambda v: tuple(map(int, v.split('.')))
    version = min((v['ApiVersion'] for v in versions), key=key)
    assert all(key(version) >= key(v['MinAPIVersion']) for v in versions)
    emit('negotiation', engines=[{k:v[k] for k in ['Version','ApiVersion','MinAPIVersion']} for v in versions], selected=version, sameVersion=versions[0]['Version']==versions[1]['Version'])
    (root / 'Dockerfile').write_text('FROM postgres:17-alpine\nLABEL devchain.proof=ffe78fcf\nCOPY offline-marker /offline-marker\n')
    (root / 'offline-marker').write_text('built locally without a registry push\n')
    docker('home','build','--network=none','-t',image,str(root))
    start = time.monotonic()
    exporter = subprocess.Popen(argv('home', ['sudo','-n','docker','save',image]), stdout=subprocess.PIPE)
    loader = subprocess.run(argv('vm',['sudo','-n','docker','load']), stdin=exporter.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    exporter.stdout.close()
    assert exporter.wait()==0 and loader.returncode==0
    emit('offline-image-stream', seconds=round(time.monotonic()-start,3), imageIdEqual=json.loads(docker('home','image','inspect',image))[0]['Id']==json.loads(docker('vm','image','inspect',image))[0]['Id'])
    compose = {'name':prefix,'services':{'db':{'image':image,'environment':{'POSTGRES_HOST_AUTH_METHOD':'trust'},'labels':{'devchain.proof':'ffe78fcf'},'volumes':['db:/var/lib/postgresql/data','/anon',str(root/'project'/'data')+':/bind',str(root/'project')+':/project']}},'volumes':{'db':{'labels':{'devchain.proof':'ffe78fcf'}}},'networks':{'default':{'labels':{'devchain.proof':'ffe78fcf'}}}}
    config = root / 'compose.json'
    config.write_text(json.dumps(compose))
    (root/'project'/'data').mkdir(parents=True)
    run('vm','mkdir','-p',str(root/'project'/'data'))
    run('vm','tee',str(config),data=config.read_bytes())
    compose_args = ['compose','-f',str(config)]
    normalized=json.loads(docker('home',*compose_args,'config','--format','json'))
    emit('compose-normalized', services=list(normalized['services']))
    docker('home',*compose_args,'up','-d')
    compose_name = prefix + '-db-1'
    remember('home','containers',compose_name)
    remember('home','networks',prefix+'_default')
    run_name = create('home',prefix+'-run','-e','POSTGRES_HOST_AUTH_METHOD=trust','-v','/var/lib/postgresql/data','-v',prefix+'-run-named:/named','-v',str(root/'project'/'data')+':/bind',image)
    for name in [compose_name,run_name]:
        for mount in inspect('home',name)['Mounts']:
            if mount['Type']=='volume': remember('home','volumes',mount['Name'])
    docker('home','start',run_name)
    for name in [compose_name,run_name]:
        wait_pg('home',name)
        sql('home',name,"CREATE TABLE proof(value text); INSERT INTO proof VALUES ('home-row');")
        docker('home','exec',name,'sh','-c','mkdir -p /bind/nested; echo proof > /bind/nested/file; chown 1234:2345 /bind/nested/file; chmod 640 /bind/nested/file; ln -sf nested/file /bind/link')
        extra='/anon' if name==compose_name else '/named'
        docker('home','exec',name,'sh','-c','echo volume-proof > '+extra+'/file; chown 1234:2345 '+extra+'/file; chmod 640 '+extra+'/file')
        docker('home','stop','-t','10',name)
    captured = [inspect('home',name) for name in [compose_name,run_name]]
    copied = {}
    bind_sources = {m['Source'] for saved in captured for m in saved['Mounts'] if m['Type']=='bind'}
    counter = 0
    for saved in captured:
        for mount in saved['Mounts']:
            if mount['Type']=='volume': remember('home','volumes',mount['Name'])
            identity = (mount['Type'], mount['Source'])
            if identity in copied: continue
            counter += 1
            destination = mount['Source'] if mount['Type']=='bind' else mount['Name']
            copied[identity]=destination
            if mount['Type']=='bind' and any(mount['Source'].startswith(parent+'/') for parent in bind_sources if parent!=mount['Source']):
                emit('overlap-deduplicated', child=mount['Source'])
                continue
            copy_mount('home','vm',mount,destination,counter)
    net = prefix+'_default'
    remember('vm','networks',net)
    docker('vm','network','create','--label',label,'--label','com.docker.compose.project='+prefix,'--label','com.docker.compose.network=default',net)
    for saved in captured:
        name = saved['Name'].lstrip('/')
        remember('vm','containers',name)
        host = {k:saved['HostConfig'][k] for k in ['PortBindings','RestartPolicy','NetworkMode','ShmSize']}
        host['Binds']=[copied[(m['Type'],m['Source'])]+':'+m['Destination']+('' if m['RW'] else ':ro') for m in saved['Mounts']]
        endpoints={n:{'Aliases':v.get('Aliases')} for n,v in saved['NetworkSettings']['Networks'].items()}
        api('vm','POST','/containers/create?name='+name,{**saved['Config'],'HostConfig':host,'NetworkingConfig':{'EndpointsConfig':endpoints}})
        assert inspect('vm',name)['State']['Status']=='created'
    before=inspect('vm',compose_name)
    docker('vm',*compose_args,'up','-d')
    after=inspect('vm',compose_name)
    assert before['Id']==after['Id']
    assert sorted(m.get('Name') for m in before['Mounts'] if m['Type']=='volume')==sorted(m.get('Name') for m in after['Mounts'] if m['Type']=='volume')
    emit('compose-reuse', containerIdSame=before['Id']==after['Id'], beforeVolumes=[m.get('Name') for m in before['Mounts'] if m['Type']=='volume'], afterVolumes=[m.get('Name') for m in after['Mounts'] if m['Type']=='volume'])
    docker('vm','start',run_name)
    for name in [compose_name,run_name]:
        wait_pg('vm',name)
        extra='/anon' if name==compose_name else '/named'
        assert docker('vm','exec',name,'cat',extra+'/file')=='volume-proof'
        assert docker('vm','exec',name,'cat','/offline-marker')=='built locally without a registry push'
        rows=sql('vm',name,'SELECT value FROM proof ORDER BY value')
        assert rows=='home-row'
        sql('vm',name,"INSERT INTO proof VALUES ('vm-row');")
        docker('vm','stop','-t','10',name)
        emit('agent-started-postgres', kind='compose' if name==compose_name else 'run', rowsVerified=True)
    counter=100
    for saved in captured:
        for mount in saved['Mounts']:
            counter+=1
            copy_mount('vm','home',mount,copied[(mount['Type'],mount['Source'])],counter)
    for name in [compose_name,run_name]:
        docker('home','start',name)
        wait_pg('home',name)
        assert sql('home',name,'SELECT value FROM proof ORDER BY value')=='home-row\nvm-row'
        docker('home','stop','-t','10',name)
    emit('roundtrip', composeRows=True, runRows=True)
    dbmount=next(m for m in captured[0]['Mounts'] if m['Destination']=='/var/lib/postgresql/data')
    docker('vm','rm',compose_name)
    docker('vm',*compose_args,'up','-d')
    wait_pg('vm',compose_name)
    generated=inspect('vm',compose_name)
    for mount in generated['Mounts']:
        if mount['Type']=='volume': remember('vm','volumes',mount['Name'])
    docker('vm','exec',compose_name,'sh','-c','echo stale > /var/lib/postgresql/data/vm-only')
    emit('second-connect-holder', createdByCompose=True, differsFromImported=generated['Id']!=after['Id'], volume=dbmount['Name'])
    docker('vm','stop','-t','10',compose_name)
    docker('vm','rm',compose_name)
    docker('vm','volume','rm',dbmount['Name'])
    copy_mount('home','vm',dbmount,dbmount['Name'],200)
    docker('vm',*compose_args,'up','-d')
    wait_pg('vm',compose_name)
    current=inspect('vm',compose_name)
    for mount in current['Mounts']:
        if mount['Type']=='volume': remember('vm','volumes',mount['Name'])
    staleGone=run('vm','sudo','-n','docker','exec',compose_name,'test','!','-e','/var/lib/postgresql/data/vm-only',check=False).returncode==0
    assert staleGone
    assert sql('vm',compose_name,'SELECT value FROM proof ORDER BY value')=='home-row\nvm-row'
    emit('second-connect-fresh-copy', staleGone=staleGone, rowsVerified=True)
    docker('home','start',compose_name)
    wait_pg('home',compose_name)
    docker('home','stop','-t','10',compose_name)
    docker('vm','stop','-t','10',compose_name)
    docker('vm','rm',compose_name)
    docker('vm','volume','rm',dbmount['Name'])
    docker('vm','volume','create','--label',label,dbmount['Name'])
    partial=create('vm',prefix+'-cancel-partial','-v',dbmount['Name']+':/payload',image,'true')
    docker('vm','rm',partial)
    docker('vm','volume','rm',dbmount['Name'])
    docker('home','start',compose_name)
    wait_pg('home',compose_name)
    assert sql('home',compose_name,'SELECT value FROM proof ORDER BY value')=='home-row\nvm-row'
    assert inspect('home',run_name)['State']['Status']=='exited'
    emit('second-connect-cancel', onlyPreviouslyRunningSourceRestarted=True, partialVolumeRemoved=True, previousTargetCopyRestored=False)
    docker('home','stop','-t','10',compose_name)
finally:
    for side in reversed(initialized):
        for name in reversed(resources[side]['containers']): run(side,'sudo','-n','docker','rm','-f',name,check=False)
        for name in resources[side]['volumes']: run(side,'sudo','-n','docker','volume','rm',name,check=False)
        for name in resources[side]['networks']: run(side,'sudo','-n','docker','network','rm',name,check=False)
        run(side,'sudo','-n','docker','image','rm',image,check=False)
        run(side,'sudo','-n','rm','-rf','--',str(root),check=False)
    if not initialized:
        root.rmdir()
    emit('cleanup', inventory=resources)
