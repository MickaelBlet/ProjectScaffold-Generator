"""Interop check of the calls between binaries (scripts/check_remote.sh): serves or calls interface
Echo of tests/fixtures/relay.scaffold.yaml over a transport, from or to interop.cpp.

    python3 interop.py <generated python dir> serve <transport> <address>
    python3 interop.py <generated python dir> call <transport> <address> <ack: true|false>
    python3 interop.py <generated python dir> peers    # ServerPeer and ClientPeer, every link
"""
import signal
import sys
import threading

sys.path.insert(0, sys.argv[1])

from relay import data  # noqa: E402
from relay.peers.client import ClientPeer  # noqa: E402
from relay.peers.server import ServerPeer  # noqa: E402
from relay.remote.echo import EchoHandler, EchoProxy, EchoStub  # noqa: E402
from relay.transport import connect, serve  # noqa: E402
from relay.wire import RemoteError  # noqa: E402


class Echo(EchoHandler):
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last = ''

    def echo(self, sample):
        return sample

    def sum(self, values):
        return sum(values)

    def scale(self, v, factor):
        return factor != 0, data.Vec3(v.x * factor, v.y * factor, v.z * factor)

    def notify(self, text):
        with self._lock:
            self._last = text

    def last(self):
        with self._lock:
            return self._last

    def samples(self, count):
        if count > 100:
            raise ValueError('too many samples')
        return [data.Sample(id=i, label=f's{i}') for i in range(count)]

    def tree(self, t):
        return t

    def pick(self, m, key):
        return m.get(key)

    def names(self, names):
        return names

    def access(self, a):
        return a

    def command(self, c):
        return c

    def item(self, i):
        return i

    def badge(self, b):
        return b


def full(raw_size: int) -> data.Sample:
    return data.Sample(
        id=2**64 - 16, mode=data.Mode.Fault, ok=False, letter='z', label='héllo wörld',
        raw=bytes(i * 7 % 256 for i in range(raw_size)),
        numbers=data.Numbers(-128, 255, -32768, 65535, -2**31, 2**32 - 1, -2**63, 2**64 - 1, 1.5, -2.25),
        pos=data.Vec3(1.0, -2.0, 3.5), path=[data.Vec3(0.5, 0.25, 0.125), data.Vec3(-1.0, -2.0, -3.0)],
        box=[1.0, 2.0, 3.5, 4.25], flags={-3, 0, 7}, history=[1, -1, 127], tags={'a': 1, 'b': -2}, note='note')


failures = 0


def check(what: str, ok: bool) -> None:
    global failures
    if not ok:
        print(f'FAILED: {what}', file=sys.stderr)
        failures += 1


def call(proxy: EchoProxy, transport: str) -> None:
    s = full(1000 if transport == 'udp' else 100000)
    check('echo', proxy.echo(s) == s)
    check('sum', proxy.sum([1, 2, 3, -10]) == -4)
    check('scale', proxy.scale(data.Vec3(1.0, 2.0, 3.0), 2.0) == (True, data.Vec3(2.0, 4.0, 6.0)))
    proxy.notify(f'hello {transport}')
    check('notify, last', proxy.last() == f'hello {transport}')
    got = proxy.samples(3)
    check('samples', len(got) == 3 and got[2].id == 2 and got[2].label == 's2')
    try:
        proxy.samples(200)
        check('error sent back', False)
    except RemoteError as e:
        check('error sent back', 'too many samples' in str(e))
    t = data.Tree('root', [data.Tree('a', []), data.Tree('b', [data.Tree('c', [])])])
    check('tree', proxy.tree(t) == t)
    m = {data.Mode.Idle: 'i', data.Mode.Run: None}
    check('pick', proxy.pick(m, data.Mode.Idle) == 'i')
    check('pick none', proxy.pick(m, data.Mode.Run) is None and proxy.pick(m, data.Mode.Fault) is None)
    check('bitmask', proxy.access(data.Access.Write | data.Access.Exec) == data.Access.Write | data.Access.Exec)
    check('bitmask default', data.Badge().access == data.Access.Read | data.Access.Exec)
    check('union default', data.Command() == data.Command(data.Mode.Idle, ''))
    c = data.Command(data.Mode.Run, 2.5)
    check('union', proxy.command(c) == c)
    check('union, no case', proxy.command(data.Command(data.Mode.Fault, None)) == data.Command(data.Mode.Fault, None))
    check('union field default', data.Badge().command == data.Command(data.Mode.Run, 1.5))
    for item in [data.Item(2, 5), data.Item(0, 'x'), data.Item(9, 'y'), data.Item(-3, ['a', 'b'])]:
        check(f'union {item}', proxy.item(item) == item)
    check('bounds', proxy.names(['a', 'bcde']) == ['a', 'bcde'])
    badge = data.Badge('ab', {1: b'\x07\x08'})
    check('bounds of fields', proxy.badge(badge) == badge)
    for what, bad in [('bound of a string', lambda: proxy.names(['abcde'])),
                      ('bound of a vector', lambda: proxy.names(['a', 'b', 'c', 'd'])),
                      ('bound of a field', lambda: proxy.badge(data.Badge('abcde', {}))),
                      ('bound of a union case', lambda: proxy.item(data.Item(-3, ['abcde']))),
                      ('bound of a map value', lambda: proxy.badge(data.Badge('a', {1: b'123'})))]:
        try:
            bad()
            check(what, False)
        except RemoteError as e:
            check(what, 'over the bound' in str(e))


def main() -> int:
    mode = sys.argv[2]
    if mode == 'serve':
        transport, address = sys.argv[3], sys.argv[4]
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        with serve(transport, address, EchoStub(Echo())):
            print('ready', flush=True)
            while not stop.wait(0.1):
                pass
        return 0
    if mode == 'call':
        transport, address, ack = sys.argv[3], sys.argv[4], sys.argv[5] == 'true'
        proxy = EchoProxy(connect(transport, address, '/echo'), ack, 3.0)
        try:
            call(proxy, transport)
        finally:
            proxy.close()
        return 1 if failures else 0
    if mode == 'peers':
        handlers = {name: Echo() for name in ('echo_tcp', 'echo_udp', 'echo_http', 'echo_websocket', 'echo_shm')}
        with ServerPeer(**handlers), ClientPeer() as client:
            for name in handlers:
                call(getattr(client, name), name[len('echo_'):])
        return 1 if failures else 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
