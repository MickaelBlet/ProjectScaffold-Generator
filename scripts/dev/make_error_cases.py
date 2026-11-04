#!/usr/bin/env python3
# Writes tests/errors/<case>.scaffold.yaml: broken variants of the fixtures, one problem each
# (some several). Their expected messages (<case>.expected) are checked by tests/cli.rs.
import copy, os, sys, yaml

class CoreLoader(yaml.SafeLoader):
    """YAML 1.2 core booleans (true / false only), as the generator reads files."""
CoreLoader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag != 'tag:yaml.org,2002:bool']
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()}
import re
CoreLoader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'), list('tTfF'))

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
out = os.path.join(root, 'tests', 'errors')
base = {n: yaml.load(open(os.path.join(root, f)), Loader=CoreLoader) for n, f in [
    ('plant', 'tests/fixtures/plant.scaffold.yaml'),
    ('relay', 'tests/fixtures/relay.scaffold.yaml'),
    ('robot', 'examples/robot.scaffold.yaml'),
    ('station', 'examples/station.scaffold.yaml'),
]}

def prim(n, **kw): return dict(kind='primitive', name=n, **kw)
def ref(n): return dict(kind='ref', name=n)
def typ(p, name): return next(t for t in p['types'] if t['name'] == name)
def mod(p, path):
    ms = p['modules']
    for part in path.split('.'):
        m = next(x for x in ms if x['name'] == part)
        ms = m.get('modules', [])
    return m

cases = {}
def case(name, src='plant'):
    def deco(f):
        p = copy.deepcopy(base[src]); r = f(p)
        cases[name] = p if r is None else r
        return f
    return deco

# --- structure (schema)
@case('schema-name-number')
def _(p): p['project']['name'] = 3
@case('schema-missing-types')
def _(p): del p['types']
@case('schema-bad-identifier')
def _(p): p['types'][0]['name'] = '1State'
@case('schema-module-kind')
def _(p): p['modules'][0]['kind'] = 'thing'
@case('schema-typeref-kind')
def _(p): p['types'][2]['type'] = {'kind': 'thing'}
@case('schema-typedef-kind')
def _(p): p['types'][0]['kind'] = 'blob'
@case('schema-max-zero')
def _(p): p['types'][1]['fields'][4]['type']['max'] = 0
@case('schema-version')
def _(p): p['schemaVersion'] = 2
@case('schema-root-list')
def _(p): return [1, 2]
@case('schema-port-role')
def _(p): p['modules'][2]['ports'][0]['role'] = 'up'
@case('schema-many')
def _(p):
    p['types'][0]['values'][0]['value'] = 1.5
    p['links'][0]['constraints']['direction'] = 'sideways'
    p['interfaces'][0]['messages'][0]['raises'] = ['1x']
    p['transports'] = ['']
@case('schema-int-string')
def _(p): p['types'][0]['values'][0]['value'] = 'x'
@case('schema-base-port', 'relay')
def _(p): p['remoteDefaults'] = {'basePort': 70000}
@case('schema-editor-key')
def _(p): p['editor'] = {'layout': {'1a': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}}
@case('schema-returns-missing')
def _(p): del p['interfaces'][0]['messages'][0]['returns']
# --- names (load)
@case('load-duplicate-type')
def _(p): p['types'].append(copy.deepcopy(p['types'][0]))
@case('load-type-interface-clash')
def _(p): p['types'].append({'kind': 'primitive', 'name': 'Sink'})
@case('load-duplicate-constant')
def _(p): p['constants'] = [{'name': 'State', 'type': prim('int8'), 'value': 1}]
@case('load-unknown-type')
def _(p): p['types'][1]['fields'][0]['type'] = {'kind': 'vector', 'of': ref('Nope')}
@case('load-interface-as-type')
def _(p): p['types'][2]['type'] = ref('Sink')
@case('load-unknown-raises')
def _(p): p['interfaces'][0]['messages'][0]['raises'] = ['Nope']
@case('load-duplicate-module')
def _(p): p['modules'].append(copy.deepcopy(p['modules'][3]))
@case('load-duplicate-port')
def _(p): p['modules'][2]['ports'].append(copy.deepcopy(p['modules'][2]['ports'][0]))
@case('load-unknown-interface')
def _(p): p['modules'][2]['ports'][0]['interface'] = 'Nope'
@case('load-unknown-binary', 'relay')
def _(p): p['modules'][0]['binary'] = 'Nope'
@case('load-inner-binary', 'relay')
def _(p):
    m = p['modules'][0]
    m.setdefault('modules', []).append({'name': 'Inner', 'binary': p['binaries'][0]['name'], 'ports': []})
@case('load-unknown-base')
def _(p): p['modules'][3]['bases'] = ['Nope']
@case('load-unknown-link-module')
def _(p): p['links'][0]['from']['module'] = 'Nope'
@case('load-unknown-link-port')
def _(p): p['links'][0]['to']['port'] = 'nope'
@case('load-unknown-dependency-use', 'station')
def _(p): p['dependencies'][0]['uses'] = ['Nope']
@case('load-duplicate-binary', 'relay')
def _(p): p['binaries'].append(copy.deepcopy(p['binaries'][0]))
@case('load-link-unknown-project', 'station')
def _(p):
    l = next(x for x in p['links'] if x['from'].get('project') or x['to'].get('project'))
    (l['from'] if l['from'].get('project') else l['to'])['project'] = 'Nope'
# --- semantics (validate)
@case('validate-reserved-name')
def _(p): p['types'].append({'kind': 'primitive', 'name': 'vector'})
@case('validate-exception-as-type')
def _(p):
    p['types'].append({'kind': 'exception', 'name': 'Oops', 'fields': []})
    p['types'][1]['fields'][0]['type'] = ref('Oops')
@case('validate-bounded-int')
def _(p): p['types'][1]['fields'][5]['type'] = prim('uint64', max=4)
@case('validate-map-key')
def _(p): p['types'][1]['fields'][2]['type']['key'] = ref('Reading')
@case('validate-defaults')
def _(p):
    f = p['types'][1]['fields']
    f[0]['default'] = 'x'
    f[1]['default'] = 'Maybe'
    f[2]['default'] = [1]
    f[4]['default'] = 12
    f[5]['default'] = 18446744073709551616
@case('validate-default-struct')
def _(p):
    p['types'].append({'kind': 'struct', 'name': 'Pair', 'fields': [
        {'name': 'a', 'type': ref('Reading'), 'default': {'value': 2, 'bogus': 1}},
        {'name': 'b', 'type': {'kind': 'array', 'of': prim('char'), 'size': 2}, 'default': ['ab', 'c', 'd']},
        {'name': 'c', 'type': {'kind': 'set', 'of': prim('int8')}, 'default': [1, 1, 300]},
        {'name': 'd', 'type': prim('string', max=3), 'default': 'abcdé'},
    ]})
@case('validate-duplicate-field')
def _(p): p['types'][1]['fields'].append(copy.deepcopy(p['types'][1]['fields'][0]))
@case('validate-enum')
def _(p):
    v = p['types'][0]['values']
    v.append({'name': 'Off', 'value': 2}); v.append({'name': 'Big', 'value': 300})
@case('validate-bitmask')
def _(p): p['types'].append({'kind': 'bitmask', 'name': 'Flags', 'underlying': 'uint8', 'flags': [
    {'name': 'a', 'bit': 0}, {'name': 'a', 'bit': 0}, {'name': 'b', 'bit': 8}]})
@case('validate-union')
def _(p): p['types'].append({'kind': 'union', 'name': 'U', 'discriminator': ref('Reading'), 'cases': [
    {'name': 'x', 'type': prim('bool'), 'default': True}, {'name': 'x', 'type': prim('bool'), 'default': True},
    {'name': 'y', 'type': prim('bool')}]})
@case('validate-union-labels')
def _(p): p['types'].append({'kind': 'union', 'name': 'U', 'discriminator': ref('State'), 'cases': [
    {'name': 'x', 'type': prim('bool'), 'labels': ['On', 'Nope']}, {'name': 'y', 'type': prim('bool'), 'labels': ['On']}]})
@case('validate-alias-cycle')
def _(p):
    p['types'].append({'kind': 'alias', 'name': 'A', 'type': ref('B')})
    p['types'].append({'kind': 'alias', 'name': 'B', 'type': ref('A')})
@case('validate-struct-cycle')
def _(p):
    p['types'].append({'kind': 'struct', 'name': 'S', 'fields': [{'name': 't', 'type': ref('T')}]})
    p['types'].append({'kind': 'struct', 'name': 'T', 'fields': [{'name': 's', 'type': {'kind': 'optional', 'of': ref('S')}}]})
@case('validate-interface')
def _(p):
    i = p['interfaces'][0]
    i['messages'].append(copy.deepcopy(i['messages'][0]))
    i['messages'][0]['params'].append(copy.deepcopy(i['messages'][0]['params'][0]))
    i['messages'][0]['raises'] = ['Reading', 'Reading']
@case('validate-constants')
def _(p): p['constants'] = [{'name': 'K', 'type': prim('int8'), 'value': 1000}, {'name': 'L', 'type': ref('State'), 'value': 'Nope'}]
@case('validate-methods')
def _(p):
    m = p['modules'][2]
    m['methods'] = [
        {'name': 'a', 'params': [], 'returns': None, 'static': True, 'const': True, 'virtual': True},
        {'name': 'b', 'params': [{'name': 'x', 'type': prim('int8'), 'direction': 'out', 'const': True}], 'returns': None, 'pure': True},
        {'name': 'b', 'params': [], 'returns': None, 'override': True, 'virtual': True},
    ]
    m.setdefault('attributes', []).append({'name': 'a', 'type': prim('bool')})
@case('validate-module-members')
def _(p):
    m = p['modules'][2]
    m['types'] = [{'kind': 'primitive', 'name': m['ports'][0]['name']}]
    m.setdefault('attributes', []).extend([{'name': 'z', 'type': prim('bool'), 'default': 3}, {'name': 'z', 'type': prim('bool')}])
@case('validate-bases', 'plant')
def _(p):
    ms = p['modules']
    ms.append({'name': 'B1', 'kind': 'abstract', 'bases': ['B2'], 'ports': [], 'methods': [{'name': 'f', 'params': [], 'returns': None, 'virtual': True, 'pure': True}]})
    ms.append({'name': 'B2', 'kind': 'abstract', 'bases': ['B1', 'B1'], 'ports': []})
    ms.append({'name': 'C', 'bases': ['B1', 'C'], 'ports': [], 'methods': [{'name': 'g', 'params': [], 'returns': None, 'override': True, 'virtual': True}]})
    ms.append({'name': 'I', 'kind': 'interface', 'ports': [], 'attributes': [{'name': 'a', 'type': prim('bool')}], 'methods': [{'name': 'h', 'params': [], 'returns': None}]})
@case('validate-override-signature')
def _(p):
    ms = p['modules']
    ms.append({'name': 'Root', 'kind': 'abstract', 'ports': [], 'methods': [{'name': 'f', 'params': [{'name': 'x', 'type': prim('int8')}], 'returns': None, 'virtual': True}]})
    ms.append({'name': 'D', 'bases': ['Root'], 'ports': [], 'methods': [{'name': 'f', 'params': [{'name': 'x', 'type': prim('int16')}], 'returns': None, 'virtual': True, 'override': True}]})
@case('validate-no-binary', 'relay')
def _(p): p['modules'][0].pop('binary', None)
@case('validate-links')
def _(p):
    l = p['links'][0]
    l['constraints']['direction'] = 'unidirectional'
    l['constraints']['ack'] = {'required': True}
    p['links'].append(copy.deepcopy(l))
    f, t = l['from'], l['to']
    p['links'].append({'name': 'back', 'from': dict(t), 'to': dict(f), 'constraints': copy.deepcopy(l['constraints'])})
@case('validate-remote', 'relay')
def _(p):
    for l in p['links']:
        r = l['constraints']['remote']
        if r.get('enabled'):
            r['enabled'] = False
            break
    for l in p['links']:
        r = l['constraints']['remote']
        if r.get('enabled'):
            r.pop('transport', None)
            break
@case('validate-active')
def _(p):
    p['modules'].append({'name': 'Worker', 'kind': 'abstract', 'active': True, 'ports': []})
    p['modules'].append({'name': 'Tools', 'instantiation': 'utility', 'active': {'queue': 4}, 'ports': []})
@case('schema-active-queue')
def _(p): p['modules'].append({'name': 'Busy', 'active': {'queue': 0}, 'ports': []})
@case('validate-module-type-access', 'robot')
def _(p):
    p['types'].append({'kind': 'alias', 'name': 'Outside', 'type': ref('Core.Sensor.Sample')})
    p['modules'].append({'name': 'Other', 'ports': [], 'attributes': [{'name': 's', 'type': ref('Core.Sensor.Sample')}]})
@case('validate-dependency-cycle', 'station')
def _(p):
    d = p['dependencies']
    d.append({'name': 'Other', 'file': 'other.scaffold.yaml', 'types': [], 'interfaces': []})
    d[0]['uses'] = ['Other']; d[-1]['uses'] = [d[0]['name']]

names = sys.argv[1:] or cases
for n in names:
    with open(os.path.join(out, n + '.scaffold.yaml'), 'w') as f:
        yaml.safe_dump(cases[n], f, sort_keys=False, allow_unicode=True)
print(len(names), 'cases')
