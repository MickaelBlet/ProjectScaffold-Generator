// Interop check of the calls between binaries (scripts/check_remote.sh): serves or calls interface
// Echo of tests/fixtures/relay.scaffold.yaml over a transport, from or to interop.py.
//   interop serve <transport> <address>
//   interop call <transport> <address> <ack: true|false>
#include <relay/remote/EchoProxy.hpp>
#include <relay/remote/EchoStub.hpp>

#include <climits>
#include <cstring>
#include <iostream>
#include <mutex>

using namespace relay;
using remote::EchoProxy;
using remote::EchoStub;

namespace {

class Echo final : public IEcho {
public:
    Sample echo(const Sample& sample) override { return sample; }

    void sum(const std::vector<std::int32_t>& values, std::int64_t& total) override
    {
        total = 0;
        for (const std::int32_t v : values) total += v;
    }

    bool scale(Vec3& v, double factor) override
    {
        v.x *= factor;
        v.y *= factor;
        v.z *= factor;
        return factor != 0;
    }

    void notify(const std::string& text) override
    {
        const std::lock_guard<std::mutex> lock(mutex_);
        last_ = text;
    }

    std::string last() override
    {
        const std::lock_guard<std::mutex> lock(mutex_);
        return last_;
    }

    Samples samples(std::uint8_t count) override
    {
        if (count > 100) throw std::runtime_error("too many samples");
        Samples out(count);
        for (std::uint8_t i = 0; i < count; ++i) {
            out[i].id = i;
            out[i].label = "s" + std::to_string(i);
        }
        return out;
    }

    Tree tree(const Tree& t) override { return t; }

    std::optional<std::string> pick(const std::map<Mode, std::optional<std::string>>& m, Mode key) override
    {
        const auto it = m.find(key);
        return it == m.end() ? std::nullopt : it->second;
    }

    Names names(const Names& names) override { return names; }

    Badge badge(const Badge& b) override { return b; }

private:
    std::mutex mutex_;
    std::string last_;
};

template <class T>
remote::Bytes bytes(const T& value)
{
    remote::Writer w;
    remote::encode(w, value);
    return w.bytes();
}

Sample full(std::size_t rawSize)
{
    Sample s;
    s.id = 0xFFFFFFFFFFFFFFF0ull;
    s.mode = Mode::Fault;
    s.ok = false;
    s.letter = 'z';
    s.label = "h\xc3\xa9llo w\xc3\xb6rld";
    s.raw.resize(rawSize);
    for (std::size_t i = 0; i < rawSize; ++i) s.raw[i] = static_cast<std::uint8_t>(i * 7);
    s.numbers = Numbers{-128, 255, -32768, 65535, INT32_MIN, UINT32_MAX, INT64_MIN, UINT64_MAX, 1.5f, -2.25};
    s.pos = Vec3{1.0, -2.0, 3.5};
    s.path = {Vec3{0.5, 0.25, 0.125}, Vec3{-1.0, -2.0, -3.0}};
    s.box = {1.0f, 2.0f, 3.5f, 4.25f};
    s.flags = {-3, 0, 7};
    s.history = {1, -1, 127};
    s.tags = {{"a", 1}, {"b", -2}};
    s.note = "note";
    return s;
}

int failures = 0;

void check(const char* what, bool ok)
{
    if (!ok) {
        std::cerr << "FAILED: " << what << '\n';
        ++failures;
    }
}

int call(EchoProxy& proxy, const std::string& transport)
{
    const Sample s = full(transport == "udp" ? 1000 : 100000);
    check("echo", bytes(proxy.echo(s)) == bytes(s));

    std::int64_t total = 0;
    proxy.sum({1, 2, 3, -10}, total);
    check("sum", total == -4);

    Vec3 v{1.0, 2.0, 3.0};
    check("scale result", proxy.scale(v, 2.0));
    check("scale inout", v.x == 2.0 && v.y == 4.0 && v.z == 6.0);

    proxy.notify("hello " + transport);
    check("notify, last", proxy.last() == "hello " + transport);

    const Samples got = proxy.samples(3);
    check("samples", got.size() == 3 && got[2].id == 2 && got[2].label == "s2");
    try {
        proxy.samples(200);
        check("error sent back", false);
    } catch (const remote::Error& e) {
        check("error sent back", std::strstr(e.what(), "too many samples") != nullptr);
    }

    const Tree t{"root", {Tree{"a", {}}, Tree{"b", {Tree{"c", {}}}}}};
    check("tree", bytes(proxy.tree(t)) == bytes(t));

    const std::map<Mode, std::optional<std::string>> m{{Mode::Idle, "i"}, {Mode::Run, std::nullopt}};
    check("pick", proxy.pick(m, Mode::Idle) == std::optional<std::string>("i"));
    check("pick none", !proxy.pick(m, Mode::Run) && !proxy.pick(m, Mode::Fault));

    check("bounds", proxy.names({"a", "bcde"}) == Names{"a", "bcde"});
    const Badge badge{"ab", {{1, {7, 8}}}};
    check("bounds of fields", bytes(proxy.badge(badge)) == bytes(badge));
    const auto rejected = [](const char* what, auto&& call) {
        try {
            call();
            check(what, false);
        } catch (const remote::Error& e) {
            check(what, std::strstr(e.what(), "over the bound") != nullptr);
        }
    };
    rejected("bound of a string", [&] { proxy.names({"abcde"}); });
    rejected("bound of a vector", [&] { proxy.names({"a", "b", "c", "d"}); });
    rejected("bound of a field", [&] { proxy.badge(Badge{"abcde", {}}); });
    rejected("bound of a map value", [&] { proxy.badge(Badge{"a", {{1, {1, 2, 3}}}}); });
    return failures ? 1 : 0;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc < 4) {
        std::cerr << "usage: interop serve|call <transport> <address> [ack]\n";
        return 2;
    }
    const std::string mode = argv[1];
    const std::string transport = argv[2];
    const std::string address = argv[3];
    try {
        if (mode == "serve") {
            Echo echo;
            EchoStub stub;
            stub.bind(echo);
            stub.serve(transport, address);
            std::cout << "ready" << std::endl;
            remote::waitForStop();
            return 0;
        }
        EchoProxy proxy;
        proxy.open(remote::connect(transport, address, "/echo"), argc > 4 && std::strcmp(argv[4], "true") == 0,
                   std::chrono::milliseconds(3000));
        return call(proxy, transport);
    } catch (const std::exception& e) {
        std::cerr << "interop: " << e.what() << '\n';
        return 1;
    }
}
