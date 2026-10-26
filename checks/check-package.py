"""Disposable package integrity check; no application or network execution."""
from pathlib import Path
from urllib.parse import unquote
import json
import re

root = Path(__file__).resolve().parents[1]
docs = root / 'docs' / 'architecture'
required = ['ARCHITECTURE.md', 'DOMAIN_CONTRACTS.ts', 'schema.sql', 'openapi.yaml',
            'VERIFICATION_PLAN.md', 'IMPLEMENTATION_PLAN.md', 'ASSETS_AND_MIGRATION.md']
for name in required:
    assert (docs / name).is_file() and (docs / name).stat().st_size, name

links = 0
for file in [root / 'README.md', *docs.glob('*.md')]:
    assert file.is_file(), file
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', file.read_text()):
        target = target.strip().strip('<>')
        if re.match(r'[A-Za-z][A-Za-z0-9+.-]*:', target) or target.startswith('#'):
            continue
        path = unquote(target.split('#', 1)[0])
        assert (file.parent / path).exists(), f'{file}: broken link {target}'
        links += 1

json_files = list(docs.glob('*.json'))
for file in json_files:
    json.loads(file.read_text())

objects = 0
def closed_objects(node):
    global objects
    if isinstance(node, dict):
        if node.get('type') == 'object':
            assert node.get('additionalProperties') is False
            assert set(node.get('required', [])) == set(node.get('properties', {}))
            objects += 1
        for value in node.values():
            closed_objects(value)
    elif isinstance(node, list):
        for value in node:
            closed_objects(value)

closed_objects(json.loads((docs / 'model-output.schema.json').read_text()))
assert objects > 0
print(json.dumps({'required_files': len(required), 'local_markdown_links': links,
                  'json_files': len(json_files), 'closed_model_objects': objects,
                  'result': 'passed'}, indent=2))
