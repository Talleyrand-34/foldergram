"""
Laya canonicalization HTTP service.

Runs on minisforum (or anywhere reachable from the foldergram server).
Listens on port 4001. The foldergram plugin talks to it after every
MiniMax-M3 analysis pass to:
  - Canonicalize each M3-proposed domain against the existing graph
  - Confirm or detect the language

Single endpoint: POST /canonicalize
Body: { state: str, suggested_domains: [str], suggested_language: str,
        existing_domains: [{ name, video_count }], existing_languages: [str] }
Response: { domains: [{ original, status, canonical, confidence, reason }],
            language: { status, canonical, confidence } }

Apache 2.0 model — self-hosted, no API key.
"""

import os
import sys
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

from laya import Router

PORT = int(os.environ.get('LAYA_PORT', '4001'))
HOST = os.environ.get('LAYA_HOST', '0.0.0.0')

# Lazy-init the router on first request (model download takes ~30-60s).
_router: Router | None = None


def get_router() -> Router:
    global _router
    if _router is None:
        # preload the two checkpoints we'll use most
        _router = Router(preload=['english', 'multilingual'])
    return _router


# Question templates. We ask laya to map each M3 suggestion to an
# existing node, OR identify it as a new domain that needs to be created.

DOMAIN_QUESTIONS = {
    'type': 'choice',
    'instructions': (
        'Match this M3-proposed video domain to an EXISTING node in the '
        'knowledge graph. Pick the existing domain that means the same thing. '
        'If nothing matches, pick NEW.'
    ),
    'criteria': {
        'MATCH_EXISTING': 'synonym or close alias of an existing domain',
        'NEW': 'not present in the existing list — should be registered fresh',
    },
}

LANGUAGE_QUESTION = {
    'type': 'choice',
    'instructions': (
        'Pick the canonical ISO 639-1 language code for this text. '
        'Prefer an existing known language. If the text is in a language '
        'not in the existing list, pick NEW with the right ISO code.'
    ),
    'criteria': {},  # filled at runtime from existing_languages + "NEW"
}


def build_domain_questions(suggested_domains, existing_domain_names):
    questions = {}
    for i, sug in enumerate(suggested_domains):
        criteria = {d: None for d in existing_domain_names}
        criteria['NEW'] = None
        questions[f'domain_{i}'] = {
            'type': 'choice',
            'instructions': (
                f'Domain suggestion #{i}: "{sug}". Match an existing node by '
                f'meaning, or pick NEW if it is genuinely novel.'
            ),
            'criteria': criteria,
        }
    return questions


def build_language_question(existing_languages):
    criteria = {lang: None for lang in existing_languages}
    criteria['NEW'] = None
    return {
        'type': 'choice',
        'instructions': (
            'Pick the canonical ISO 639-1 code. Prefer an existing one. '
            'Pick NEW with the correct code if not in the list.'
        ),
        'criteria': criteria,
    }


def canonicalize_request(req: dict) -> dict:
    state = req['state']
    suggested_domains = req.get('suggested_domains', [])
    existing_domain_names = [d['name'] for d in req.get('existing_domains', [])]
    suggested_language = req.get('suggested_language')
    existing_languages = req.get('existing_languages', [])

    router = get_router()
    questions = {}
    for i, sug in enumerate(suggested_domains):
        questions[f'domain_{i}'] = build_domain_questions(
            [sug], existing_domain_names
        )[f'domain_0']
    if suggested_language:
        questions['language'] = build_language_question(existing_languages)

    res = router.predict(state, questions)
    answers = res.get('answers', {})

    # Build canonical result
    out_domains = []
    for i, sug in enumerate(suggested_domains):
        a = answers.get(f'domain_{i}', {})
        choice = a.get('choice', 'NEW')
        confidence = a.get('confidence', 0.0)
        if choice == 'NEW':
            canonical = _slugify(sug)
            status = 'new'
            reason = ''
        else:
            canonical = choice
            status = 'alias' if canonical.lower() != sug.lower() else 'match'
            reason = ''
        out_domains.append({
            'original': sug,
            'status': status,
            'canonical': canonical,
            'confidence': confidence,
            'reason': reason,
        })

    out_lang = None
    if suggested_language:
        a = answers.get('language', {})
        choice = a.get('choice', 'NEW')
        confidence = a.get('confidence', 0.0)
        if choice == 'NEW':
            out_lang = {
                'status': 'new',
                'canonical': suggested_language,
                'confidence': confidence,
            }
        else:
            out_lang = {
                'status': 'known',
                'canonical': choice,
                'confidence': confidence,
            }

    return {
        'domains': out_domains,
        'language': out_lang,
        'model': res.get('routing', {}).get('model', 'unknown'),
    }


def _slugify(s: str) -> str:
    out = []
    for ch in s.lower().strip():
        if ch.isalnum() or ch in '/-':
            out.append(ch)
        elif ch in ' _':
            out.append('-')
    s = ''.join(out).strip('-')
    return s or 'misc/unknown'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'status': 'ok', 'model': 'laya-router'})
            return
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/canonicalize':
            self._json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            result = canonicalize_request(body)
            self._json(200, result)
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write(f'[laya-classifier] {fmt % args}\n')


if __name__ == '__main__':
    print(f'[laya-classifier] loading model (first call takes ~30s)...', flush=True)
    get_router()
    print(f'[laya-classifier] model loaded, listening on http://{HOST}:{PORT}', flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()
