#!/usr/bin/env python3
"""Push observatory files to GitHub using the Data API (repo) and Contents API (portal).

Usage:
  push_observatory.py repo      # pushes workspace x402-observatory/ -> Payloadhq/x402-observatory (main)
  push_observatory.py portal    # pushes dashboard/+api/ -> Payloadhq/payloadhq.github.io x402-observatory/
"""
import base64
import json
import os
import sys
import urllib.request

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
import dynamic_credentials as dc

CRED = 'custom.github'
ALLOWED = ('api.github.com',)
OBS = os.path.expanduser('~/workspace/products/x402-observatory')


def api(method, path, payload=None):
    url = 'https://api.github.com' + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'Payload-Observatory-Push')
    if data:
        req.add_header('Content-Type', 'application/json')
    dc.add_surrogate_to_request(req, CRED, allowed_hosts=ALLOWED)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return dc.read_json_response(resp)


def get_ref(owner, repo, branch):
    return api('GET', f'/repos/{owner}/{repo}/git/ref/heads/{branch}')['object']['sha']


def create_blob(owner, repo, b64):
    return api('POST', f'/repos/{owner}/{repo}/git/blobs',
               {'content': b64, 'encoding': 'base64'})['sha']


def push_tree_commit(owner, repo, branch, files, message):
    """files: {repo_path: local_path}. Creates blobs, tree, commit, updates ref."""
    base_sha = get_ref(owner, repo, branch)
    base_commit = api('GET', f'/repos/{owner}/{repo}/git/commits/{base_sha}')
    base_tree = base_commit['tree']['sha']
    tree = []
    for repo_path, local_path in sorted(files.items()):
        with open(local_path, 'rb') as f:
            raw = f.read()
        print(f'  blob {repo_path} ({len(raw)} bytes)')
        blob_sha = create_blob(owner, repo, base64.b64encode(raw).decode())
        tree.append({'path': repo_path, 'mode': '100644', 'type': 'blob', 'sha': blob_sha})
    new_tree = api('POST', f'/repos/{owner}/{repo}/git/trees',
                   {'base_tree': base_tree, 'tree': tree})['sha']
    commit = api('POST', f'/repos/{owner}/{repo}/git/commits',
                 {'message': message, 'tree': new_tree, 'parents': [base_sha]})
    api('PATCH', f'/repos/{owner}/{repo}/git/refs/heads/{branch}', {'sha': commit['sha']})
    print(f'pushed commit {commit["sha"][:8]} to {owner}/{repo}@{branch}')
    return commit['sha']


def collect(local_dir, skip=()):
    files = {}
    for root, _dirs, names in os.walk(local_dir):
        for n in names:
            full = os.path.join(root, n)
            rel = os.path.relpath(full, local_dir)
            if rel in skip or n in ('.DS_Store',):
                continue
            files[rel] = full
    return files


def put_contents(owner, repo, branch, repo_path, local_path):
    with open(local_path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    try:
        existing = api('GET', f'/repos/{owner}/{repo}/contents/{repo_path}?ref={branch}')
        sha = existing['sha']
    except Exception as e:
        sha = None
    payload = {'message': f'Observatory update {repo_path}', 'content': b64, 'branch': branch}
    if sha:
        payload['sha'] = sha
    api('PUT', f'/repos/{owner}/{repo}/contents/{repo_path}', payload)
    print(f'  contents {repo_path} ({len(b64)} b64 chars)')


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'repo'
    if mode == 'repo':
        # Skip the huge durable registry from the git repo; push the gzipped copy instead.
        skip = set()
        reg = os.path.join(OBS, 'data', 'registry.json')
        if os.path.exists(reg):
            gz = os.path.join(OBS, 'data', 'registry.json.gz')
            if not os.path.exists(gz):
                import gzip, shutil
                with open(reg, 'rb') as f_in, gzip.open(gz, 'wb') as f_out:
                    shutil.copyfileobj(f_in, f_out)
            skip.add(os.path.join('data', 'registry.json'))
            print(f'registry.json raw kept local only; pushing gzipped copy')
        files = collect(OBS, skip)
        # never push test keys or creds
        files = {k: v for k, v in files.items() if not any(x in k for x in ('.x402-test-key', 'credentials', 'secret'))}
        push_tree_commit('Payloadhq', 'x402-observatory', 'main', files,
                         'Observatory scale-up: Bazaar ingestion, validation, metrics, APIs')
    elif mode == 'portal':
        pairs = []
        for sub in ('dashboard', 'api'):
            d = os.path.join(OBS, sub)
            for root, _dirs, names in os.walk(d):
                for n in names:
                    full = os.path.join(root, n)
                    rel = os.path.relpath(full, OBS)
                    pairs.append((f'x402-observatory/{rel}', full))
        # portal copy lives in the distribution repo dir too
        portal_dir = os.path.expanduser('~/workspace/products/distribution/portal/x402-observatory')
        os.makedirs(portal_dir, exist_ok=True)
        for repo_path, full in pairs:
            dest = os.path.join(portal_dir, os.path.relpath(full, OBS))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(full, 'rb') as f:
                data = f.read()
            with open(dest, 'wb') as f:
                f.write(data)
        print(f'mirrored {len(pairs)} files to {portal_dir}')
        for repo_path, full in pairs:
            put_contents('Payloadhq', 'payloadhq.github.io', 'main', repo_path, full)
        print('portal push complete')
    else:
        raise SystemExit('unknown mode')


main()
