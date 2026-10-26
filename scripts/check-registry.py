"""Validate the actual migration against independently reviewed field policy."""
import argparse
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate(schema, registry):
    db = sqlite3.connect(':memory:')
    db.executescript(schema)
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables == set(registry['tables']), 'Unregistered or stale tables'
    columns = 0
    for table in tables:
        policy = registry['tables'][table]
        assert policy.get('retention') and policy.get('erasure'), f'{table}: missing retention/erasure'
        actual = {r[1]: r for r in db.execute('PRAGMA table_xinfo("' + table.replace('"', '""') + '")')}
        assert set(actual) == set(policy['columns']), f'{table}: unregistered or stale columns'
        for name, field in policy['columns'].items():
            column = actual[name]
            assert field['class'] in registry['classes'], f'{table}.{name}: unknown class'
            assert field.get('export'), f'{table}.{name}: missing export policy'
            assert field['sqlType'] == column[2], f'{table}.{name}: SQL type drift'
            # The registry treats primary keys as non-null identities. SQLite's
            # table_info omits notnull for the INTEGER PRIMARY KEY rowid alias.
            assert field['nullable'] == (not bool(column[3] or column[5])), f'{table}.{name}: nullability drift'
            assert field['default'] == column[4], f'{table}.{name}: default drift'
            if field['class'] in ('E', 'K'):
                assert field.get('aadRule'), f'{table}.{name}: missing AAD binding'
            if name.endswith('_enc'):
                assert field['class'] in ('E', 'K'), f'{table}.{name}: encrypted field misclassified'
        columns += len(actual)
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    db.close()
    return {'tables': len(tables), 'columns': columns, 'coverage': 'complete'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--schema', type=Path)
    parser.add_argument('--migrations', type=Path, default=ROOT / 'src/worker/db/migrations')
    parser.add_argument('--registry', type=Path, default=ROOT / 'src/worker/db/column-registry.json')
    args = parser.parse_args()
    paths = [args.schema] if args.schema else sorted(args.migrations.glob('*.sql'))
    assert paths, 'No migrations found'
    schema = '\n'.join(path.read_text() for path in paths)
    print(json.dumps(validate(schema, json.loads(args.registry.read_text()))))
