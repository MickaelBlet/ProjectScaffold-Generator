# context.awk - generation context (src/codegen/context.ts): the project file, resolved for
# templates. Language neutral: names only, every optional value present (templates run with
# strict variables), modules flattened with their links sorted into wiring at the right level.
#
# ctx_build(file) -> dict; file: the project file as read (checked, see load.awk).

# ------------------------------------------------------------ type refs ----

# Places a type: TO_KIND / TO_DEP / TO_MOD / TO_DEF by key, the first definition winning.
function ctx_place(key, t, dep, mod) {
	if (key in TO_KIND) return
	TO_KIND[key] = DS(t, "kind")
	TO_DEP[key] = dep
	TO_MOD[key] = mod
	TO_DEF[key] = t
}

function ctx_place_modules(list, parent,    i, m, path, ts, j, t) {
	for (i = 0; i < VN[list]; i++) {
		m = VE[list, i]
		path = parent != "" ? parent "." DS(m, "name") : DS(m, "name")
		ts = DL(m, "types")
		for (j = 0; j < VN[ts]; j++) {
			t = VE[ts, j]
			ctx_place(path "." DS(t, "name"), t, "", path)
		}
		ctx_place_modules(DL(m, "modules"), path)
	}
}

# Sets scope (list) and flatName of `d`, a type or reference named `name` in `module`.
function ctx_scoped(d, name, module,    scope, parts, n, i, flat) {
	scope = v_list()
	flat = ""
	if (module != "") {
		n = split(module, parts, ".")
		for (i = 1; i <= n; i++) {
			push(scope, v_str(parts[i]))
			flat = flat parts[i] "_"
		}
	}
	set(d, "scope", scope)
	set(d, "flatName", v_str(flat name))
}

function ctx_null_or(s) { return s == "" ? V_NONE : v_str(s) }

# Resolved type reference: refs with their kind and owner, every bound present (null when none).
function ctx_ref(t,    k, r, name, key, at) {
	k = DS(t, "kind")
	r = v_dict()
	set(r, "kind", v_str(k))
	if (k == "primitive") {
		set(r, "name", D(t, "name"))
		set(r, "max", DN(t, "max"))
	} else if (k == "ref") {
		key = DS(t, "name")
		at = 0
		name = key
		sub(/.*\./, "", name)
		set(r, "name", v_str(name))
		set(r, "typeKind", v_str((key in TO_KIND) ? TO_KIND[key] : "primitive"))
		set(r, "dependency", ctx_null_or(TO_DEP[key]))
		set(r, "key", v_str(key))
		ctx_scoped(r, name, TO_MOD[key])
	} else if (k == "array") {
		set(r, "of", ctx_ref(D(t, "of")))
		set(r, "size", D(t, "size"))
	} else if (k == "optional") {
		set(r, "of", ctx_ref(D(t, "of")))
	} else if (k == "map") {
		set(r, "key", ctx_ref(D(t, "key")))
		set(r, "value", ctx_ref(D(t, "value")))
		set(r, "max", DN(t, "max"))
	} else {
		set(r, "of", ctx_ref(D(t, "of")))
		set(r, "max", DN(t, "max"))
	}
	return r
}

# Labels as text set as keys of USED (cleared first), for unusedLabel.
function ctx_label_text(v,    t) {
	t = VT[v]
	if (t == "bool") return VV[v] ? "true" : "false"
	if (t == "none") return "null"
	return v_tostr(v)
}

# A discriminator value no label of USED is: for the default case of a union; `none` when none.
function ctx_unused_label(t, depth,    k, def, vals, i, c, n) {
	k = DS(t, "kind")
	if (k == "ref") {
		def = TO_DEF[DS(t, "name")]
		if (def && DS(def, "kind") == "alias" && depth < 32) return ctx_unused_label(D(def, "type"), depth + 1)
		if (def && DS(def, "kind") == "enum") {
			vals = DL(def, "values")
			for (i = 0; i < VN[vals]; i++) if (!(DS(VE[vals, i], "name") in USED)) return v_str(DS(VE[vals, i], "name"))
		}
		return V_NONE
	}
	if (k != "primitive") return V_NONE
	if (DS(t, "name") == "bool") {
		if (!("true" in USED)) return V_TRUE
		if (!("false" in USED)) return V_FALSE
		return V_NONE
	}
	if (DS(t, "name") == "char") {
		for (c = 32; c < 127; c++) if (!(CHR[c] in USED)) return v_str(CHR[c])
		return V_NONE
	}
	for (n = 0; ; n++) if (!((n "") in USED)) return v_int(n)
}

function ctx_field(f,    g) {
	g = v_dict()
	set(g, "name", D(f, "name"))
	set(g, "type", ctx_ref(D(f, "type")))
	set(g, "description", v_str(DS(f, "description")))
	set(g, "hasDefault", v_bool(D(f, "default") != 0))
	set(g, "default", DN(f, "default"))
	return g
}

function ctx_map_fields(list,    r, i) {
	r = v_list()
	for (i = 0; i < VN[list]; i++) push(r, ctx_field(VE[list, i]))
	return r
}

function ctx_no_uses(    u) {
	u = v_dict()
	set(u, "types", v_list())
	set(u, "builtins", v_list())
	return u
}

# Type of the file, of `dependency` ("" for the project's), of the module at `module` ("" none).
function ctx_type_def(t, dependency, module,    g, k, name, l, src, i, x, y, cases, c, labels, j, lab) {
	name = DS(t, "name")
	k = DS(t, "kind")
	g = v_dict()
	set(g, "entity", v_str("type"))
	set(g, "name", v_str(name))
	set(g, "description", v_str(DS(t, "description")))
	set(g, "dependency", ctx_null_or(dependency))
	set(g, "uses", ctx_no_uses())
	set(g, "key", v_str(module != "" ? (dependency != "" ? dependency "/" : "") module "." name : name))
	set(g, "module", ctx_null_or(module))
	set(g, "access", v_str(DH(t, "access") && DS(t, "access") != "" ? DS(t, "access") : "public"))
	ctx_scoped(g, name, module)
	set(g, "kind", v_str(k))
	if (k == "struct" || k == "exception") set(g, "fields", ctx_map_fields(DL(t, "fields")))
	else if (k == "enum") {
		set(g, "underlying", D(t, "underlying"))
		l = v_list()
		src = DL(t, "values")
		for (i = 0; i < VN[src]; i++) {
			x = v_dict()
			set(x, "name", D(VE[src, i], "name"))
			set(x, "value", D(VE[src, i], "value"))
			push(l, x)
		}
		set(g, "values", l)
	} else if (k == "bitmask") {
		set(g, "underlying", D(t, "underlying"))
		l = v_list()
		src = DL(t, "flags")
		for (i = 0; i < VN[src]; i++) {
			x = v_dict()
			set(x, "name", D(VE[src, i], "name"))
			set(x, "bit", D(VE[src, i], "bit"))
			set(x, "value", v_str(pow2(DS(VE[src, i], "bit") + 0)))
			push(l, x)
		}
		set(g, "flags", l)
	} else if (k == "union") {
		delete USED
		cases = DL(t, "cases")
		for (i = 0; i < VN[cases]; i++) {
			labels = DL(VE[cases, i], "labels")
			for (j = 0; j < VN[labels]; j++) USED[ctx_label_text(VE[labels, j])] = 1
		}
		set(g, "discriminator", ctx_ref(D(t, "discriminator")))
		y = 0
		l = v_list()
		for (i = 0; i < VN[cases]; i++) {
			c = VE[cases, i]
			if (DB(c, "default")) y = 1
			x = v_dict()
			set(x, "name", D(c, "name"))
			set(x, "type", ctx_ref(D(c, "type")))
			set(x, "description", v_str(DS(c, "description")))
			labels = DL(c, "labels")
			set(x, "labels", v_lcopy(labels))
			set(x, "isDefault", v_bool(DB(c, "default")))
			if (VN[labels]) lab = VE[labels, 0]
			else if (DB(c, "default")) lab = ctx_unused_label(D(t, "discriminator"), 0)
			else lab = V_NONE
			set(x, "label", lab)
			set(x, "index", v_int(i + 1))
			push(l, x)
		}
		set(g, "hasDefault", v_bool(y))
		set(g, "cases", l)
	} else if (k == "alias") set(g, "type", ctx_ref(D(t, "type")))
	return g
}

# 2^n as decimal text, exact for any n.
function pow2(n,    s, i, j, carry, d, r) {
	s = "1"
	for (i = 0; i < n; i++) {
		r = ""
		carry = 0
		for (j = length(s); j >= 1; j--) {
			d = substr(s, j, 1) * 2 + carry
			carry = int(d / 10)
			r = (d % 10) r
		}
		s = (carry ? carry : "") r
	}
	return s
}

function ctx_message(m,    g, params, src, i, p, x, ins, outs, raises, r, rr) {
	params = v_list()
	ins = v_list()
	outs = v_list()
	src = DL(m, "params")
	for (i = 0; i < VN[src]; i++) {
		p = VE[src, i]
		x = v_dict()
		set(x, "name", D(p, "name"))
		set(x, "type", ctx_ref(D(p, "type")))
		set(x, "description", v_str(DS(p, "description")))
		set(x, "direction", v_str(DH(p, "direction") ? DS(p, "direction") : "in"))
		set(x, "const", v_bool(DB(p, "const")))
		push(params, x)
		if (DS(x, "direction") != "out") push(ins, x)
		if (DS(x, "direction") != "in") push(outs, x)
	}
	g = v_dict()
	set(g, "name", D(m, "name"))
	set(g, "description", v_str(DS(m, "description")))
	set(g, "params", params)
	set(g, "inputs", ins)
	set(g, "outputs", outs)
	set(g, "returns", DH(m, "returns") ? ctx_ref(D(m, "returns")) : V_NONE)
	raises = v_list()
	src = DL(m, "raises")
	for (i = 0; i < VN[src]; i++) {
		r = v_dict()
		set(r, "kind", v_str("ref"))
		set(r, "name", VE[src, i])
		push(raises, ctx_ref(r))
	}
	set(g, "raises", raises)
	return g
}

function ctx_iface(i, dependency,    g, l, src, j) {
	g = v_dict()
	set(g, "entity", v_str("interface"))
	set(g, "name", D(i, "name"))
	set(g, "description", v_str(DS(i, "description")))
	set(g, "dependency", ctx_null_or(dependency))
	l = v_list()
	src = DL(i, "messages")
	for (j = 0; j < VN[src]; j++) push(l, ctx_message(VE[src, j]))
	set(g, "messages", l)
	set(g, "uses", ctx_no_uses())
	return g
}

function ctx_constant(c, dependency,    g) {
	g = v_dict()
	set(g, "entity", v_str("constant"))
	set(g, "name", D(c, "name"))
	set(g, "description", v_str(DS(c, "description")))
	set(g, "dependency", ctx_null_or(dependency))
	set(g, "type", ctx_ref(D(c, "type")))
	set(g, "value", DN(c, "value"))
	return g
}

# ---------------------------------------------------------------- uses ----

# Adds the user types (UT_KEYS, by key) and builtins (UB) a reference uses.
function ctx_walk(r,    k, key) {
	k = DS(r, "kind")
	if (k == "ref") {
		key = DS(r, "key")
		if (key in TYPE_BY_KEY) UT[key] = TYPE_BY_KEY[key]
		return
	}
	UB[k == "primitive" ? DS(r, "name") : k] = 1
	if (k == "map") {
		ctx_walk(D(r, "key"))
		ctx_walk(D(r, "value"))
	} else if (k != "primitive") ctx_walk(D(r, "of"))
}

# Starts collecting uses (builtins: names separated by spaces).
function ctx_uses_start(builtins,    n, a, i) {
	delete UT
	delete UB
	n = split(builtins, a, " ")
	for (i = 1; i <= n; i++) UB[a[i]] = 1
}

function ctx_uses_refs(refs,    i) {
	for (i = 0; i < VN[refs]; i++) ctx_walk(VE[refs, i])
}

# Uses collected: {types (by name then key), builtins (sorted)}.
function ctx_uses_end(    u, types, b, k, t) {
	types = v_list()
	for (k in UT) {
		t = UT[k]
		push(types, t)
		SK[t] = DS(t, "name") "\001" DS(t, "key")
	}
	sort_by_key(types)
	b = v_list()
	for (k in UB) push(b, v_str(k))
	sort_strings(b)
	u = v_dict()
	set(u, "types", types)
	set(u, "builtins", b)
	return u
}

function ctx_message_refs(m, refs,    ps, i, rs) {
	ps = D(m, "params")
	for (i = 0; i < VN[ps]; i++) push(refs, D(VE[ps, i], "type"))
	if (VT[D(m, "returns")] != "none") push(refs, D(m, "returns"))
	rs = D(m, "raises")
	for (i = 0; i < VN[rs]; i++) push(refs, VE[rs, i])
	return refs
}

function ctx_type_uses(t,    k, refs, l, i, c) {
	k = DS(t, "kind")
	refs = v_list()
	if (k == "struct" || k == "exception") {
		ctx_uses_start(k == "exception" ? "exception" : "")
		l = D(t, "fields")
		for (i = 0; i < VN[l]; i++) push(refs, D(VE[l, i], "type"))
	} else if (k == "alias") {
		ctx_uses_start("")
		push(refs, D(t, "type"))
	} else if (k == "union") {
		l = D(t, "cases")
		ctx_uses_start(VN[l] ? "variant" : "")
		push(refs, D(t, "discriminator"))
		for (i = 0; i < VN[l]; i++) push(refs, D(VE[l, i], "type"))
	} else ctx_uses_start(k == "enum" || k == "bitmask" ? DS(t, "underlying") : "")
	ctx_uses_refs(refs)
	set(t, "uses", ctx_uses_end())
}

# ------------------------------------------------------------- modules ----

function ctx_instantiated(m) {
	return !v_truth(D(m, "abstract")) || VN[D(m, "ports")] > 0
}

function ctx_instances(children,    l, i) {
	l = v_list()
	for (i = 0; i < VN[children]; i++) if (ctx_instantiated(VE[children, i])) push(l, VE[children, i])
	return l
}

function ctx_walk_module(m, namespace, binary,    g, path, kind, l, src, i, a, x, p, ns2, iname, children) {
	path = joinl(namespace, ".")
	path = path != "" ? path "." DS(m, "name") : DS(m, "name")
	kind = DH(m, "kind") ? DS(m, "kind") : ""
	g = v_dict()
	set(g, "entity", v_str("module"))
	set(g, "name", D(m, "name"))
	set(g, "path", v_str(path))
	set(g, "namespace", namespace)
	set(g, "parent", VN[namespace] ? v_str(joinl(namespace, ".")) : V_NONE)
	set(g, "depth", v_int(VN[namespace]))
	set(g, "binary", ctx_null_or(binary))
	set(g, "description", v_str(DS(m, "description")))
	set(g, "kind", v_str(kind != "" ? kind : "class"))
	set(g, "abstract", v_bool(kind != "" && kind != "class"))
	set(g, "bases", v_list())
	set(g, "isBase", V_FALSE)
	set(g, "metadata", DH(m, "metadata") ? v_dcopy(D(m, "metadata")) : v_dict())
	set(g, "color", DN(m, "color"))
	l = v_list()
	src = DL(m, "types")
	for (i = 0; i < VN[src]; i++) push(l, ctx_type_def(VE[src, i], "", path))
	set(g, "types", l)
	l = v_list()
	src = DL(m, "attributes")
	for (i = 0; i < VN[src]; i++) {
		a = VE[src, i]
		x = ctx_field(a)
		set(x, "access", v_str(DH(a, "access") ? DS(a, "access") : "public"))
		set(x, "static", v_bool(DB(a, "static")))
		set(x, "const", v_bool(DB(a, "const")))
		push(l, x)
	}
	set(g, "attributes", l)
	set(g, "uses", ctx_no_uses())
	l = v_list()
	src = DL(m, "methods")
	for (i = 0; i < VN[src]; i++) {
		a = VE[src, i]
		x = ctx_message(a)
		set(x, "access", v_str(DH(a, "access") ? DS(a, "access") : "public"))
		set(x, "static", v_bool(DB(a, "static")))
		set(x, "const", v_bool(DB(a, "const")))
		set(x, "virtual", v_bool(DB(a, "virtual")))
		set(x, "pure", v_bool(DB(a, "pure")))
		set(x, "override", v_bool(DB(a, "override")))
		push(l, x)
	}
	set(g, "methods", l)
	l = v_list()
	src = DL(m, "ports")
	for (i = 0; i < VN[src]; i++) {
		p = VE[src, i]
		x = v_dict()
		set(x, "name", D(p, "name"))
		set(x, "role", D(p, "role"))
		set(x, "description", v_str(DS(p, "description")))
		iname = DS(p, "interface")
		set(x, "interface", iname != "" && (iname in IFACE_BY_NAME) ? IFACE_BY_NAME[iname] : V_NONE)
		set(x, "delegates", v_list())
		push(l, x)
	}
	set(g, "ports", l)
	set(g, "children", v_list())
	set(g, "instances", v_list())
	set(g, "connections", v_list())
	push(CTX_MODULES, g)
	extend(CTX_MODULE_TYPES, D(g, "types"))
	BY_PATH[path] = g
	BASES_OF[g] = D(m, "bases")
	ns2 = v_lcopy(namespace)
	push(ns2, D(m, "name"))
	children = v_list()
	src = DL(m, "modules")
	for (i = 0; i < VN[src]; i++) push(children, ctx_walk_module(VE[src, i], v_lcopy(ns2), binary))
	set(g, "children", children)
	set(g, "instances", ctx_instances(children))
	return g
}

# --------------------------------------------------------------- links ----

function ctx_host_port(h,    g) {
	g = v_dict()
	set(g, "host", DN(h, "host"))
	set(g, "port", DN(h, "port"))
	return g
}

function ctx_settings(s,    g, l, o, i, k, x) {
	g = v_dict()
	set(g, "client", ctx_host_port(D(s, "client")))
	set(g, "server", ctx_host_port(D(s, "server")))
	set(g, "path", DN(s, "path"))
	set(g, "name", DN(s, "name"))
	set(g, "capacity", DN(s, "capacity"))
	set(g, "socket", DN(s, "socket"))
	set(g, "broker", ctx_host_port(D(s, "broker")))
	set(g, "topic", DN(s, "topic"))
	set(g, "interface", DN(s, "interface"))
	set(g, "id", DN(s, "id"))
	set(g, "device", DN(s, "device"))
	set(g, "baud", DN(s, "baud"))
	l = v_list()
	o = D(s, "options")
	if (o && VT[o] == "dict")
		for (i = 0; i < VN[o]; i++) {
			k = VK[o, i]
			x = v_dict()
			set(x, "name", k)
			set(x, "value", VD[o, v_hk(k)])
			push(l, x)
		}
	set(g, "options", l)
	return g
}

function ctx_end(e,    g) {
	g = v_dict()
	set(g, "project", DN(e, "project"))
	set(g, "module", D(e, "module"))
	set(g, "port", D(e, "port"))
	return g
}

function ctx_link(l,    c, g, x, y) {
	c = D(l, "constraints")
	g = v_dict()
	set(g, "name", D(l, "name"))
	set(g, "description", v_str(DS(l, "description")))
	set(g, "from", ctx_end(D(l, "from")))
	set(g, "to", ctx_end(D(l, "to")))
	x = v_dict()
	set(x, "direction", D(c, "direction"))
	y = v_dict()
	set(y, "required", D(D(c, "ack"), "required"))
	set(y, "timeoutMs", DN(D(c, "ack"), "timeoutMs"))
	set(x, "ack", y)
	y = v_dict()
	set(y, "class", D(D(c, "performance"), "class"))
	set(y, "maxLatencyMs", DN(D(c, "performance"), "maxLatencyMs"))
	set(y, "rateHz", DN(D(c, "performance"), "rateHz"))
	set(x, "performance", y)
	y = v_dict()
	set(y, "enabled", D(D(c, "remote"), "enabled"))
	set(y, "transport", DN(D(c, "remote"), "transport"))
	set(y, "settings", ctx_settings(D(D(c, "remote"), "settings")))
	set(x, "remote", y)
	set(g, "constraints", x)
	return g
}

# Fields of the settings of a built-in transport (transports.ts), separated by spaces.
function transport_fields(t) {
	if (t == "ipc") return "socket"
	if (t == "shm") return "name capacity"
	if (t == "tcp" || t == "udp" || t == "grpc") return "client server"
	if (t == "http" || t == "websocket") return "client server path"
	if (t == "mqtt") return "broker topic"
	if (t == "can") return "interface id"
	if (t == "serial") return "device baud"
	return ""
}

function ctx_has_field(fields, f) { return index(" " fields " ", " " f " ") > 0 }

# Settings of link `l` (of the file), the `index`th between binaries, with the defaults of its transport.
function ctx_resolve_settings(l, idx,    s, fields, port, r, h, x, k, i) {
	s = D(D(D(l, "constraints"), "remote"), "settings")
	fields = transport_fields(DS(D(D(l, "constraints"), "remote"), "transport"))
	port = REMOTE_BASE_PORT + idx
	r = v_dict()
	if (s && VT[s] == "dict") for (i = 0; i < VN[s]; i++) v_dset(r, VK[s, i], VD[s, v_hk(VK[s, i])])
	if (ctx_has_field(fields, "client")) set(r, "client", ctx_default_host(D(s, "client"), REMOTE_CLIENT_HOST, port))
	if (ctx_has_field(fields, "server")) set(r, "server", ctx_default_host(D(s, "server"), REMOTE_SERVER_HOST, port))
	if (ctx_has_field(fields, "path")) set(r, "path", DH(s, "path") ? D(s, "path") : v_str("/" DS(l, "name")))
	if (ctx_has_field(fields, "name")) set(r, "name", DH(s, "name") ? D(s, "name") : v_str(snake(CTX_IDENT "_" DS(l, "name"))))
	if (ctx_has_field(fields, "capacity")) set(r, "capacity", DH(s, "capacity") ? D(s, "capacity") : v_int(1048576))
	return ctx_settings(r)
}

# { host, port, ...given } as JavaScript spreads it: given keys (even null) win.
function ctx_default_host(given, host, port,    h, i) {
	h = v_dict()
	set(h, "host", v_str(host))
	set(h, "port", v_int(port))
	if (given && VT[given] == "dict") for (i = 0; i < VN[given]; i++) v_dset(h, VK[given, i], VD[given, v_hk(VK[given, i])])
	return h
}

function ctx_endpoint(via, module, port,    g) {
	g = v_dict()
	set(g, "via", via)
	set(g, "module", v_str(module))
	set(g, "port", v_str(port))
	return g
}

# Children to go through from the module at `scope` ("": the system) to the module at `path`.
function ctx_via(scope, path,    a, n, s, b, i, l) {
	n = split(path, a, ".")
	s = scope == "" ? 0 : split(scope, b, ".")
	l = v_list()
	for (i = s + 1; i <= n; i++) push(l, v_str(a[i]))
	return l
}

function ctx_port(path, name,    m, ps, i) {
	if (!(path in BY_PATH)) return 0
	m = BY_PATH[path]
	ps = D(m, "ports")
	for (i = 0; i < VN[ps]; i++) if (DS(VE[ps, i], "name") == name) return VE[ps, i]
	return 0
}

# System of a module path; 0 for a module of no binary.
function ctx_system_at(path,    top) {
	if (!CTX_NBIN) return VE[CTX_SYSTEMS, 0]
	top = path
	sub(/\..*/, "", top)
	return (top in SYSTEM_OF_TOP) ? SYSTEM_OF_TOP[top] : 0
}

function ctx_system(binary, children,    g) {
	g = v_dict()
	set(g, "entity", v_str("system"))
	set(g, "name", v_str(binary ? DS(binary, "name") "System" : "System"))
	set(g, "binary", binary ? binary : V_NONE)
	set(g, "children", children)
	set(g, "instances", ctx_instances(children))
	set(g, "connections", v_list())
	set(g, "external", v_list())
	set(g, "proxies", v_list())
	set(g, "stubs", v_list())
	set(g, "uses", ctx_no_uses())
	return g
}

function ctx_where(binary, module, port,    g) {
	g = v_dict()
	set(g, "binary", v_str(binary))
	set(g, "module", v_str(module))
	set(g, "port", v_str(port))
	return g
}

function ctx_reach(t,    n, us, i) {
	n = DS(t, "name")
	if (n in REMOTE_TYPE) return
	REMOTE_TYPE[n] = t
	us = D(D(t, "uses"), "types")
	for (i = 0; i < VN[us]; i++) ctx_reach(VE[us, i])
}

# ----------------------------------------------------------------- build ----

function ctx_build(file,    ctx, i, j, x, d, list, g, warnings, types, interfaces, constants, deps, all_types, all_ifaces, all_mtypes, top, bases, b, binaries, systems, bin, flinks, links, l, from, to, local, remote, sys, fm, tm, aseg, bseg, n, scope, conn, at, peer, face, idx, settings, remote_ifaces, remote_links, rl, rt, rc, ok, ps, p, dl, ifile, constants_file, refs, rd, mod_bin, project, pr) {
	delete TO_KIND; delete TO_DEP; delete TO_MOD; delete TO_DEF
	delete TYPE_BY_KEY; delete IFACE_BY_NAME; delete BY_PATH; delete BASES_OF
	delete SYSTEM_OF_TOP; delete REMOTE_TYPE; delete REMOTE_IFACE
	warnings = v_list()
	list = DL(file, "types")
	for (i = 0; i < VN[list]; i++) ctx_place(DS(VE[list, i], "name"), VE[list, i], "", "")
	ctx_place_modules(DL(file, "modules"), "")
	deps = DL(file, "dependencies")
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		list = DL(d, "types")
		for (j = 0; j < VN[list]; j++) ctx_place(DS(VE[list, j], "name"), VE[list, j], DS(d, "name"), "")
		list = DL(d, "moduleTypes")
		for (j = 0; j < VN[list]; j++) {
			g = VE[list, j]
			tm = DL(g, "types")
			for (x = 0; x < VN[tm]; x++)
				ctx_place(DS(d, "name") "/" DS(g, "module") "." DS(VE[tm, x], "name"), VE[tm, x], DS(d, "name"), DS(g, "module"))
		}
	}

	types = v_list()
	list = DL(file, "types")
	for (i = 0; i < VN[list]; i++) push(types, ctx_type_def(VE[list, i], "", ""))
	interfaces = v_list()
	list = DL(file, "interfaces")
	for (i = 0; i < VN[list]; i++) push(interfaces, ctx_iface(VE[list, i], ""))
	constants = v_list()
	list = DL(file, "constants")
	for (i = 0; i < VN[list]; i++) push(constants, ctx_constant(VE[list, i], ""))
	dl = v_list()
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		g = v_dict()
		set(g, "name", D(d, "name"))
		set(g, "file", D(d, "file"))
		set(g, "indirect", v_bool(DB(d, "indirect")))
		x = v_list()
		list = DL(d, "types")
		for (j = 0; j < VN[list]; j++) push(x, ctx_type_def(VE[list, j], DS(d, "name"), ""))
		set(g, "types", x)
		x = v_list()
		list = DL(d, "moduleTypes")
		for (j = 0; j < VN[list]; j++) {
			tm = DL(VE[list, j], "types")
			for (a = 0; a < VN[tm]; a++) push(x, ctx_type_def(VE[tm, a], DS(d, "name"), DS(VE[list, j], "module")))
		}
		set(g, "moduleTypes", x)
		x = v_list()
		list = DL(d, "interfaces")
		for (j = 0; j < VN[list]; j++) push(x, ctx_iface(VE[list, j], DS(d, "name")))
		set(g, "interfaces", x)
		x = v_list()
		list = DL(d, "constants")
		for (j = 0; j < VN[list]; j++) push(x, ctx_constant(VE[list, j], DS(d, "name")))
		set(g, "constants", x)
		push(dl, g)
	}
	all_types = v_lcopy(types)
	all_ifaces = v_lcopy(interfaces)
	for (i = 0; i < VN[dl]; i++) {
		extend(all_types, D(VE[dl, i], "types"))
		extend(all_ifaces, D(VE[dl, i], "interfaces"))
	}
	for (i = 0; i < VN[all_ifaces]; i++) {
		x = VE[all_ifaces, i]
		if (!(DS(x, "name") in IFACE_BY_NAME)) IFACE_BY_NAME[DS(x, "name")] = x
	}

	# Modules, depth first.
	CTX_MODULES = v_list()
	CTX_MODULE_TYPES = v_list()
	delete BIN_NAME
	list = DL(file, "binaries")
	for (i = 0; i < VN[list]; i++) BIN_NAME[DS(VE[list, i], "name")] = 1
	top = v_list()
	list = DL(file, "modules")
	for (i = 0; i < VN[list]; i++) {
		fm = VE[list, i]
		mod_bin = DS(fm, "binary")
		push(top, ctx_walk_module(fm, v_list(), mod_bin != "" && (mod_bin in BIN_NAME) ? mod_bin : ""))
	}
	for (i = 0; i < VN[CTX_MODULES]; i++) {
		g = VE[CTX_MODULES, i]
		bases = BASES_OF[g]
		b = v_list()
		for (j = 0; bases && VT[bases] == "list" && j < VN[bases]; j++) {
			x = v_tostr(VE[bases, j])
			if (x in BY_PATH) {
				set(BY_PATH[x], "isBase", V_TRUE)
				push(b, BY_PATH[x])
			}
		}
		set(g, "bases", b)
	}

	# What each entity uses, now that every type exists.
	all_mtypes = v_lcopy(CTX_MODULE_TYPES)
	for (i = 0; i < VN[dl]; i++) extend(all_mtypes, D(VE[dl, i], "moduleTypes"))
	x = concat(all_types, all_mtypes)
	for (i = 0; i < VN[x]; i++) if (!(DS(VE[x, i], "key") in TYPE_BY_KEY)) TYPE_BY_KEY[DS(VE[x, i], "key")] = VE[x, i]
	for (i = 0; i < VN[x]; i++) ctx_type_uses(VE[x, i])
	for (i = 0; i < VN[all_ifaces]; i++) {
		g = VE[all_ifaces, i]
		refs = v_list()
		list = D(g, "messages")
		for (j = 0; j < VN[list]; j++) ctx_message_refs(VE[list, j], refs)
		ctx_uses_start("")
		ctx_uses_refs(refs)
		set(g, "uses", ctx_uses_end())
	}
	constants_file = v_dict()
	set(constants_file, "entity", v_str("constants"))
	set(constants_file, "name", v_str("constants"))
	set(constants_file, "dependency", V_NONE)
	refs = v_list()
	for (i = 0; i < VN[constants]; i++) push(refs, D(VE[constants, i], "type"))
	ctx_uses_start("")
	ctx_uses_refs(refs)
	set(constants_file, "uses", ctx_uses_end())
	# A module's types are declared in its class (`using`): it uses them.
	for (i = 0; i < VN[CTX_MODULES]; i++) {
		g = VE[CTX_MODULES, i]
		refs = v_list()
		list = D(g, "types")
		for (j = 0; j < VN[list]; j++) {
			x = VE[list, j]
			rd = v_dict()
			set(rd, "kind", v_str("ref"))
			set(rd, "name", D(x, "name"))
			set(rd, "typeKind", D(x, "kind"))
			set(rd, "dependency", D(x, "dependency"))
			set(rd, "key", D(x, "key"))
			set(rd, "scope", D(x, "scope"))
			set(rd, "flatName", D(x, "flatName"))
			push(refs, rd)
		}
		list = D(g, "attributes")
		for (j = 0; j < VN[list]; j++) push(refs, D(VE[list, j], "type"))
		list = D(g, "methods")
		for (j = 0; j < VN[list]; j++) ctx_message_refs(VE[list, j], refs)
		ctx_uses_start("")
		ctx_uses_refs(refs)
		set(g, "uses", ctx_uses_end())
	}

	# One system per binary, or one for the whole project.
	binaries = v_list()
	list = DL(file, "binaries")
	for (i = 0; i < VN[list]; i++) {
		g = v_dict()
		set(g, "name", D(VE[list, i], "name"))
		set(g, "description", v_str(DS(VE[list, i], "description")))
		set(g, "color", DN(VE[list, i], "color"))
		set(g, "modules", v_list())
		push(binaries, g)
	}
	CTX_NBIN = VN[binaries]
	list = DL(file, "modules")
	delete BIN_OF_TOP
	for (i = 0; i < VN[list]; i++) {
		fm = VE[list, i]
		bin = 0
		for (j = 0; j < VN[binaries]; j++) if (DH(fm, "binary") && DS(VE[binaries, j], "name") == DS(fm, "binary")) { bin = VE[binaries, j]; break }
		if (bin) {
			push(D(bin, "modules"), VE[top, i])
			BIN_OF_TOP[DS(fm, "name")] = j
		} else if (CTX_NBIN) push(warnings, v_str("Module '" DS(fm, "name") "' runs in no binary: left out"))
	}
	systems = v_list()
	if (CTX_NBIN) for (i = 0; i < CTX_NBIN; i++) push(systems, ctx_system(VE[binaries, i], D(VE[binaries, i], "modules")))
	else push(systems, ctx_system(0, top))
	CTX_SYSTEMS = systems
	for (x in BIN_OF_TOP) SYSTEM_OF_TOP[x] = VE[systems, BIN_OF_TOP[x]]

	project = D(file, "project")
	CTX_IDENT = dependency_name(DS(project, "name"))
	rd = D(file, "remoteDefaults")
	REMOTE_CLIENT_HOST = DH(D(rd, "client"), "host") ? DS(D(rd, "client"), "host") : "127.0.0.1"
	REMOTE_SERVER_HOST = DH(D(rd, "server"), "host") ? DS(D(rd, "server"), "host") : "127.0.0.1"
	REMOTE_BASE_PORT = DH(rd, "basePort") ? DS(rd, "basePort") + 0 : 47000

	remote_ifaces = v_list()
	remote_links = v_list()
	flinks = DL(file, "links")
	links = v_list()
	for (i = 0; i < VN[flinks]; i++) push(links, ctx_link(VE[flinks, i]))
	for (i = 0; i < VN[links]; i++) {
		l = VE[links, i]
		from = D(l, "from")
		to = D(l, "to")
		if (DH(from, "project") || DH(to, "project")) {
			local = DH(from, "project") ? to : from
			remote = DH(from, "project") ? from : to
			if (DH(local, "project")) continue
			sys = ctx_system_at(DS(local, "module"))
			if (sys) {
				g = v_dict()
				set(g, "link", l)
				set(g, "local", ctx_endpoint(ctx_via("", DS(local, "module")), DS(local, "module"), DS(local, "port")))
				set(g, "side", v_str(DH(from, "project") ? "to" : "from"))
				x = v_dict()
				set(x, "project", D(remote, "project"))
				set(x, "module", D(remote, "module"))
				set(x, "port", D(remote, "port"))
				set(g, "remote", x)
				push(D(sys, "external"), g)
			}
			continue
		}
		fm = DS(from, "module")
		tm = DS(to, "module")
		if (!(fm in BY_PATH) || !(tm in BY_PATH)) {
			push(warnings, v_str("Link '" DS(l, "name") "' has a missing endpoint"))
			continue
		}
		if (index(tm, fm ".") == 1) {
			# A container's `in` port handing its calls to an inner `in` port.
			p = ctx_port(fm, DS(from, "port"))
			if (p) push(D(p, "delegates"), ctx_endpoint(ctx_via(fm, tm), tm, DS(to, "port")))
			continue
		}
		if (index(fm, tm ".") == 1) {
			# An inner `out` port going out through the container's `out` port.
			p = ctx_port(tm, DS(to, "port"))
			if (p) push(D(p, "delegates"), ctx_endpoint(ctx_via(tm, fm), fm, DS(from, "port")))
			continue
		}
		# Wired by the innermost module holding both ends.
		x = split(fm, aseg, ".")
		j = split(tm, bseg, ".")
		n = 0
		while (n < x - 1 && n < j - 1 && aseg[n + 1] == bseg[n + 1]) n++
		scope = ""
		for (j = 1; j <= n; j++) scope = scope "" (j > 1 ? "." : "") aseg[j]
		conn = v_dict()
		set(conn, "link", l)
		set(conn, "from", ctx_endpoint(ctx_via(scope, fm), fm, DS(from, "port")))
		set(conn, "to", ctx_endpoint(ctx_via(scope, tm), tm, DS(to, "port")))
		if (scope != "") {
			push(D(BY_PATH[scope], "connections"), conn)
			continue
		}
		at = ctx_system_at(fm)
		peer = ctx_system_at(tm)
		if (!at || !peer) continue
		if (at == peer) {
			push(D(at, "connections"), conn)
			continue
		}
		# Between binaries: a proxy sends the calls of the `from` end, a stub hands them to the `to` end.
		p = ctx_port(fm, DS(from, "port"))
		face = p ? D(p, "interface") : 0
		if (!face || VT[face] == "none") {
			push(warnings, v_str("Link '" DS(l, "name") "' between binaries has no interface: left out"))
			continue
		}
		if (!(DS(face, "name") in REMOTE_IFACE)) {
			REMOTE_IFACE[DS(face, "name")] = VN[remote_ifaces]
			push(remote_ifaces, face)
		} else VE[remote_ifaces, REMOTE_IFACE[DS(face, "name")]] = face
		idx = VN[remote_links]
		settings = ctx_resolve_settings(VE[flinks, i], idx)
		rl = v_dict()
		set(rl, "index", v_int(idx))
		set(rl, "link", l)
		set(rl, "interface", face)
		set(rl, "from", ctx_where(DS(D(at, "binary"), "name"), fm, DS(from, "port")))
		set(rl, "to", ctx_where(DS(D(peer, "binary"), "name"), tm, DS(to, "port")))
		set(rl, "settings", settings)
		push(remote_links, rl)
		g = v_dict()
		set(g, "index", v_int(idx))
		set(g, "link", l)
		set(g, "local", D(conn, "from"))
		set(g, "interface", face)
		set(g, "peer", ctx_where(DS(D(peer, "binary"), "name"), tm, DS(to, "port")))
		set(g, "settings", settings)
		push(D(at, "proxies"), g)
		g = v_dict()
		set(g, "index", v_int(idx))
		set(g, "link", l)
		set(g, "local", D(conn, "to"))
		set(g, "interface", face)
		set(g, "peer", ctx_where(DS(D(at, "binary"), "name"), fm, DS(from, "port")))
		set(g, "settings", settings)
		push(D(peer, "stubs"), g)
	}
	for (i = 0; i < VN[remote_ifaces]; i++) {
		list = D(D(VE[remote_ifaces, i], "uses"), "types")
		for (j = 0; j < VN[list]; j++) ctx_reach(VE[list, j])
	}
	rt = v_list()
	for (x in REMOTE_TYPE) {
		push(rt, REMOTE_TYPE[x])
		SK[REMOTE_TYPE[x]] = x
	}
	sort_by_key(rt)
	rc = v_list()
	for (i = 0; i < VN[constants]; i++) {
		refs = v_list()
		push(refs, D(VE[constants, i], "type"))
		ctx_uses_start("")
		ctx_uses_refs(refs)
		list = D(ctx_uses_end(), "types")
		ok = 1
		for (j = 0; j < VN[list]; j++) if (!(DS(VE[list, j], "name") in REMOTE_TYPE)) ok = 0
		if (ok) push(rc, VE[constants, i])
	}
	for (i = 0; i < VN[CTX_MODULES]; i++) {
		g = VE[CTX_MODULES, i]
		ps = D(g, "ports")
		for (j = 0; j < VN[ps]; j++) {
			p = VE[ps, j]
			list = D(p, "delegates")
			if (DS(p, "role") == "in" && VN[list] > 1)
				push(warnings, v_str(DS(g, "path") ":" DS(p, "name") " hands its calls to " VN[list] " inner ports: only " DS(VE[list, 0], "module") ":" DS(VE[list, 0], "port") " is wired"))
		}
	}

	ctx = v_dict()
	pr = v_dict()
	set(pr, "name", D(project, "name"))
	set(pr, "ident", v_str(CTX_IDENT))
	set(pr, "description", v_str(DS(project, "description")))
	set(pr, "metadata", DH(project, "metadata") ? v_dcopy(D(project, "metadata")) : v_dict())
	set(ctx, "project", pr)
	set(ctx, "transports", DH(file, "transports") ? D(file, "transports") : v_list())
	x = v_dict()
	g = v_dict()
	set(g, "host", v_str(REMOTE_CLIENT_HOST))
	set(x, "client", g)
	g = v_dict()
	set(g, "host", v_str(REMOTE_SERVER_HOST))
	set(x, "server", g)
	set(x, "basePort", v_int(REMOTE_BASE_PORT))
	set(ctx, "remoteDefaults", x)
	set(ctx, "types", types)
	set(ctx, "moduleTypes", CTX_MODULE_TYPES)
	set(ctx, "interfaces", interfaces)
	set(ctx, "modules", CTX_MODULES)
	set(ctx, "binaries", binaries)
	set(ctx, "systems", systems)
	set(ctx, "system", CTX_NBIN ? V_NONE : VE[systems, 0])
	set(ctx, "remoteInterfaces", remote_ifaces)
	set(ctx, "remoteLinks", remote_links)
	set(ctx, "remoteTypes", rt)
	set(ctx, "constants", constants)
	set(ctx, "constantsFile", constants_file)
	set(ctx, "remoteConstants", rc)
	set(ctx, "links", links)
	set(ctx, "dependencies", dl)
	set(ctx, "allTypes", all_types)
	set(ctx, "allModuleTypes", all_mtypes)
	x = v_dict()
	for (i = 0; i < VN[all_types]; i++) if (!v_dhas(x, D(VE[all_types, i], "key"))) v_dset(x, D(VE[all_types, i], "key"), VE[all_types, i])
	for (i = 0; i < VN[all_mtypes]; i++) if (!v_dhas(x, D(VE[all_mtypes, i], "key"))) v_dset(x, D(VE[all_mtypes, i], "key"), VE[all_mtypes, i])
	set(ctx, "typeByKey", x)
	set(ctx, "allInterfaces", all_ifaces)
	set(ctx, "warnings", warnings)
	return ctx
}
