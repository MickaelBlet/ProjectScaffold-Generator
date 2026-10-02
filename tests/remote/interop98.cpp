// interop.cpp in C++98, over the code generated with the cpp98 templates (scripts/check_remote.sh -t cpp98):
// serves or calls interface Echo of tests/fixtures/relay.scaffold.yaml over a transport, from or to interop.py.
//   interop serve <transport> <address>
//   interop call <transport> <address> <ack: true|false>
#include <relay/constants.hpp>
#include <relay/remote/EchoProxy.hpp>
#include <relay/remote/EchoStub.hpp>

#include <climits>
#include <cstring>
#include <iostream>

using namespace relay;
using remote::EchoProxy;
using remote::EchoStub;
using scaffold::Make;
using scaffold::Optional;

namespace {

typedef std::map<Mode, Optional<std::string> > Picks;
typedef std::map<uint8_t, std::vector<uint8_t> > Marks;

class Echo : public IEcho {
public:
    Sample echo(const Sample& sample) { return sample; }

    void sum(const std::vector<int32_t>& values, int64_t& total)
    {
        total = 0;
        for (std::size_t i = 0; i < values.size(); ++i) total += values[i];
    }

    bool scale(Vec3& v, double factor)
    {
        v.x *= factor;
        v.y *= factor;
        v.z *= factor;
        return factor != 0;
    }

    void notify(const std::string& text)
    {
        remote::Lock lock(mutex_);
        last_ = text;
    }

    std::string last()
    {
        remote::Lock lock(mutex_);
        return last_;
    }

    Samples samples(uint8_t count)
    {
        if (count > 100) throw std::runtime_error("too many samples");
        Samples out(count);
        for (uint8_t i = 0; i < count; ++i) {
            out[i].id = i;
            out[i].label = "s" + remote::toString(static_cast<int>(i));
        }
        return out;
    }

    Tree tree(const Tree& t) { return t; }

    Optional<std::string> pick(const Picks& m, Mode key)
    {
        const Picks::const_iterator it = m.find(key);
        return it == m.end() ? Optional<std::string>() : it->second;
    }

    Names names(const Names& names) { return names; }

    Access access(Access a) { return a; }

    Command command(const Command& c) { return c; }

    Item item(const Item& i) { return i; }

    bool check(int32_t level)
    {
        if (level < 0) {
            Refused e;
            e.reason = "negative";
            e.code = level;
            throw e;
        }
        if (level > 100) throw Timeout();
        return true;
    }

    Badge badge(const Badge& b) { return b; }

private:
    remote::Mutex mutex_;
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
    for (std::size_t i = 0; i < rawSize; ++i) s.raw[i] = static_cast<uint8_t>(i * 7);
    s.numbers = Numbers(-128, 255, -32768, 65535, INT_MIN, UINT_MAX, LLONG_MIN, ULLONG_MAX, 1.5f, -2.25);
    s.pos = Vec3(1.0, -2.0, 3.5);
    s.path = Make<std::vector<Vec3> >()(Vec3(0.5, 0.25, 0.125))(Vec3(-1.0, -2.0, -3.0));
    s.box = Make<scaffold::Array<float, 4> >()(1.0f)(2.0f)(3.5f)(4.25f);
    s.flags = Make<std::set<int16_t> >()(-3)(0)(7);
    s.history = Make<std::list<int8_t> >()(1)(-1)(127);
    s.tags = Make<std::map<std::string, int32_t> >()("a", 1)("b", -2);
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

/// Checks that `call()` is rejected for a value over its bound.
template <class Call>
void rejected(const char* what, Call call)
{
    try {
        call();
        check(what, false);
    } catch (const remote::Error& e) {
        check(what, std::strstr(e.what(), "over the bound") != 0);
    }
}

struct NamesCall {
    NamesCall(EchoProxy& proxy, const Names& names) : proxy(proxy), names(names) {}
    void operator()() const { proxy.names(names); }
    EchoProxy& proxy;
    Names names;
};

struct BadgeCall {
    BadgeCall(EchoProxy& proxy, const Badge& badge) : proxy(proxy), badge(badge) {}
    void operator()() const { proxy.badge(badge); }
    EchoProxy& proxy;
    Badge badge;
};

struct ItemCall {
    ItemCall(EchoProxy& proxy, const Item& item) : proxy(proxy), item(item) {}
    void operator()() const { proxy.item(item); }
    EchoProxy& proxy;
    Item item;
};

int call(EchoProxy& proxy, const std::string& transport)
{
    const Sample s = full(transport == "udp" ? 1000 : 100000);
    check("echo", bytes(proxy.echo(s)) == bytes(s));

    int64_t total = 0;
    proxy.sum(Make<std::vector<int32_t> >()(1)(2)(3)(-10), total);
    check("sum", total == -4);

    Vec3 v(1.0, 2.0, 3.0);
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
        check("error sent back", std::strstr(e.what(), "too many samples") != 0);
    }

    const Tree t("root", Make<std::vector<Tree> >()(Tree("a"))(Tree("b", Make<std::vector<Tree> >()(Tree("c")))));
    check("tree", bytes(proxy.tree(t)) == bytes(t));

    const Picks m = Make<Picks>()(Mode::Idle, "i")(Mode::Run, Optional<std::string>());
    check("pick", proxy.pick(m, Mode::Idle) == Optional<std::string>("i"));
    check("pick none", !proxy.pick(m, Mode::Run) && !proxy.pick(m, Mode::Fault));

    check("bitmask", proxy.access(Access::Write | Access::Exec) == (Access::Write | Access::Exec));
    check("bitmask default", has(Badge().access, Access::Read | Access::Exec) && !has(Badge().access, Access::Write));
    Command c;
    check("union default", c._d() == Mode::Idle && c.note().empty());
    c.speed(2.5);
    check("union", bytes(proxy.command(c)) == bytes(c) && proxy.command(c).speed() == 2.5);
    c._default(Mode::Fault);
    check("union, no case", proxy.command(c)._d() == Mode::Fault);
    check("union field default", Badge().command._d() == Mode::Run && Badge().command.speed() == 1.5);
    Item item;
    item.number(5, 2);
    check("union label", proxy.item(item)._d() == 2 && proxy.item(item).number() == 5);
    item.text("x");
    check("union default case", item._d() == 0 && proxy.item(item).text() == "x");
    item.text("y", 9);
    check("union default case label", proxy.item(item)._d() == 9 && proxy.item(item).text() == "y");
    const Names ab = Make<Names>()("a")("b");
    item.names(ab);
    check("union negative label", proxy.item(item)._d() == -3 && proxy.item(item).names() == ab);
    check("constants", MaxNames == 3 && DefaultMode == Mode::Run && DefaultAccess == (Access::Read | Access::Write));
    check("constants", Greeting == "hello" && Origin.z == 1.5 && Weights.find("a")->second == 0.5f &&
                           FirstItem._d() == 1 && FirstItem.number() == 7);
    check("raises nothing", proxy.check(5));
    try {
        proxy.check(-2);
        check("raises", false);
    } catch (const Refused& e) {
        check("raises", e.reason == "negative" && e.code == -2);
    }
    try {
        proxy.check(200);
        check("raises the second", false);
    } catch (const Timeout&) {
    }
    const Names abcde = Make<Names>()("a")("bcde");
    check("bounds", proxy.names(abcde) == abcde);
    const Badge badge("ab", Make<Marks>()(1, Make<std::vector<uint8_t> >()(7)(8)));
    check("bounds of fields", bytes(proxy.badge(badge)) == bytes(badge));
    rejected("bound of a string", NamesCall(proxy, Make<Names>()("abcde")));
    rejected("bound of a vector", NamesCall(proxy, Make<Names>()("a")("b")("c")("d")));
    rejected("bound of a field", BadgeCall(proxy, Badge("abcde")));
    Item tooLong;
    tooLong.names(Make<Names>()("abcde"));
    rejected("bound of a union case", ItemCall(proxy, tooLong));
    rejected("bound of a map value", BadgeCall(proxy, Badge("a", Make<Marks>()(1, Make<std::vector<uint8_t> >()(1)(2)(3)))));
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
        proxy.open(remote::connect(transport, address, "/echo"), argc > 4 && std::strcmp(argv[4], "true") == 0, 3000);
        return call(proxy, transport);
    } catch (const std::exception& e) {
        std::cerr << "interop: " << e.what() << '\n';
        return 1;
    }
}
