#!/usr/bin/env python3
"""Measure index MCP context bytes on a fixed corpus; never infer actual LLM tokens."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def search_repeat_count(value):
    count = int(value)
    if not 1 <= count <= 20:
        raise argparse.ArgumentTypeError('search repeats must be between 1 and 20')
    return count


def measure_search(rpc, case, original, repeats):
    samples = []
    for _ in range(repeats):
        start = time.monotonic()
        request, response = rpc('tools/call', {'name': 'search_index', 'arguments': {
            'request': {'query': case['query'], 'limit': 8}}})
        payload = response['result']
        if payload.get('isError'):
            raise RuntimeError(f"MCP search failed for {case['id']}")
        result = json.loads(payload['content'][0]['text'])['result']
        covered = any(hit['relativePath'] == case['path'] and case['expected'] in hit['excerpt']
                      for hit in result['hits'])
        # Retain metrics only, never source excerpts. Include the full JSON envelopes.
        samples.append({'covered': covered, 'requestBytes': len(encoded(request)),
                        'responseBytes': len(encoded(response)),
                        'searchMs': round((time.monotonic() - start) * 1000, 2),
                        'staleFiles': len(result['staleFiles']), 'truncated': result['truncated']})
    # Keep first-query bytes and latency comparable with existing single-search reports.
    # A later missing result or safety warning must not disappear in the summary.
    return {'id': case['id'], 'fullFileBytesProxy': len(original), **samples[0],
            'covered': all(sample['covered'] for sample in samples),
            'staleFiles': max(sample['staleFiles'] for sample in samples),
            'truncated': any(sample['truncated'] for sample in samples), 'searchSamples': samples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-bin', type=Path, required=True)
    parser.add_argument('--corpus', type=Path, required=True, help='same immutable repository snapshot for before/after')
    parser.add_argument('--static-dir', type=Path, default=Path('dist'))
    parser.add_argument('--cases', type=Path, default=Path(__file__).with_name('index-efficiency-cases.json'))
    parser.add_argument('--split', choices=['tuning', 'heldout'], default='heldout')
    parser.add_argument('--search-repeats', type=search_repeat_count, default=1,
                        help='1–20 sequential searches per case; extra traffic is reported separately')
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    cases_bytes = args.cases.read_bytes()
    cases = [case for case in json.loads(cases_bytes) if case['split'] == args.split]
    if len(cases) < (20 if args.split == 'heldout' else 1):
        parser.error('heldout requires at least 20 independent queries')
    corpus = args.corpus.resolve(strict=True)
    originals = {}
    for case in cases:
        relative = Path(case['path'])
        path = corpus / relative
        if relative.is_absolute() or '..' in relative.parts or path.is_symlink():
            parser.error('unsafe corpus path')
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(corpus):
            parser.error('corpus file escapes snapshot')
        content = resolved.read_bytes()
        if case['expected'] not in content.decode('utf-8'):
            parser.error(f"missing expected target in {case['id']}")
        originals[case['path']] = content
    fingerprint = digest(encoded({path: digest(body) for path, body in sorted(originals.items())}))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def post(url, data):
        request = urllib.request.Request(url, encoded(data), {'Content-Type': 'application/json'})
        with opener.open(request, timeout=60) as response:
            return json.load(response)

    with tempfile.TemporaryDirectory(prefix='index-efficiency-') as temporary:
        base = Path(temporary)
        home, app, documents = base / 'home', base / 'app', base / 'corpus'
        home.mkdir()
        documents.mkdir()
        for relative, content in originals.items():
            target = documents / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        # No unrelated environment values or operational provider homes reach this backend.
        env = {'HOME': str(home), 'PATH': os.defpath, 'LANG': 'C.UTF-8',
               'AGENT_MANAGER_APP_DATA_DIR': str(app)}
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        api = f'http://127.0.0.1:{port}/api/invoke/'

        def invoke(name, request):
            return post(api + name, {'request': request})

        with (base / 'backend.log').open('wb') as log:
            process = subprocess.Popen([
                str(args.server_bin.resolve(strict=True)), '--port', str(port),
                '--static-dir', str(args.static_dir.resolve()), '--app-data-dir', str(app),
                '--shutdown-on-stdin-eof'], stdin=subprocess.PIPE, stdout=log, stderr=log, env=env)
            try:
                for _ in range(240):
                    if process.poll() is not None:
                        raise RuntimeError('isolated backend exited')
                    try:
                        with opener.open(f'http://127.0.0.1:{port}/api/access', timeout=1):
                            break
                    except OSError:
                        time.sleep(.25)
                else:
                    raise RuntimeError('isolated backend startup timed out')
                invoke('set_index_settings', {'enabled': True, 'autoRefresh': False})
                source = invoke('add_index_source', {'name': 'Evaluation corpus', 'path': str(documents)})['sources'][0]
                invoke('set_index_source_enabled', {'id': source['id'], 'enabled': True})
                started = time.monotonic()
                indexed = invoke('refresh_index_source', {'id': source['id']})['sources'][0]
                refresh_ms = round((time.monotonic() - started) * 1000, 2)
                location = json.loads((app / 'index-agent-mcp.json').read_text())['url']
                endpoint = urllib.parse.urlsplit(location)
                if (endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1'
                        or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment):
                    raise RuntimeError('non-loopback MCP endpoint refused')

                def rpc(method, params=None):
                    request = {'jsonrpc': '2.0', 'id': 1, 'method': method}
                    if params is not None:
                        request['params'] = params
                    response = post(location, request)
                    if 'error' in response:
                        raise RuntimeError('MCP transport error')
                    return request, response

                listing_request, listing_response = rpc('tools/list')
                schema_bytes = len(encoded(listing_request)) + len(encoded(listing_response))
                rows = [measure_search(rpc, case, originals[case['path']], args.search_repeats)
                        for case in cases]
                report = {'metric': 'UTF-8 context bytes proxy; not actual model tokens or billing',
                          'baselineInterface': 'one whole expected file per query, content bytes only',
                          'scope': 'first search, cold schema once; extra repeat traffic reported separately; '
                                   'excludes LLM prompt, retries and follow-up reads',
                          'searchRepeats': args.search_repeats,
                          'searchLatencyScope': 'MCP round trip including backend validation; repeat calls use a warm '
                                                'process/filesystem; cache hits and revalidation-only time are not measured',
                          'repeatRequestResponseBytes': sum(sample['requestBytes'] + sample['responseBytes']
                                                            for row in rows for sample in row['searchSamples'][1:]),
                          'caseDigest': digest(cases_bytes), 'corpusDigest': fingerprint,
                          'serverDigest': digest(args.server_bin.read_bytes()), 'split': args.split,
                          'cases': len(rows), 'covered': sum(row['covered'] for row in rows),
                          'schemaBytes': schema_bytes, 'refreshMs': refresh_ms,
                          'indexBytes': (app / 'index-addon-v1.sqlite3').stat().st_size,
                          'excludedFiles': indexed['excluded'], 'partialIndex': indexed['truncated'],
                          'fullFileBytesProxy': sum(row['fullFileBytesProxy'] for row in rows),
                          'indexedBytesWithColdSchema': schema_bytes + sum(row['requestBytes'] + row['responseBytes'] for row in rows),
                          'rows': rows}
            finally:
                process.stdin.close()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    regressions = []
    if args.baseline:
        previous = json.loads(args.baseline.read_text())
        for key in ['caseDigest', 'corpusDigest', 'split', 'cases']:
            if previous[key] != report[key]:
                raise ValueError(f'incomparable baseline: {key}')
        old = {row['id']: row for row in previous['rows']}
        regressions = [row['id'] for row in rows if old[row['id']]['covered'] and not row['covered']]
        report['coverageRegressions'] = regressions
        report['contextBytesDelta'] = report['indexedBytesWithColdSchema'] - previous['indexedBytesWithColdSchema']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['cases', 'covered', 'excludedFiles',
                     'fullFileBytesProxy', 'indexedBytesWithColdSchema']}))
    if regressions:
        raise SystemExit('coverage regression; see report')


if __name__ == '__main__':
    main()
