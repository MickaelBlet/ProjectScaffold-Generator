# load.awk - reading a project file (src/model/serialize.ts loadText / fromFile): structure check
# against the schema, then names: duplicates and unknown references, reported with their line as
# the editor does. Builds the tables validate.awk and the generation use:
#
#   T_N, T_KEY[i], T_DEF[i], T_DEP[i], T_MOD[i] (own module path), T_MODPATH[i] (of a dependency's
#        module), TYPE_IDX[key]: types, in the order of the editor's model (own, of own modules
#        depth first, then each dependency's, then its modules')
#   I_N, I_DEF[i], I_DEP[i], IFACE_IDX[name]: interfaces
#   C_N, C_KEY[i], C_DEF[i], C_DEP[i], C_MOD[i], C_MODPATH[i]: constants
#   M_N, M_PATH[i], M_DEF[i], M_PARENT[i], M_BIN[i], M_IDX[path], M_BASES[i] (paths, space
#        separated, known ones): own modules, depth first
#   X_N, X_DEP[i], X_PATH[i], X_DEF[i], X_IDX["dep/path"]: placed modules of dependencies
#   L_N, L_DEF[i], L_FROM[i], L_TO[i] (module ids: own path, or "dep/path"), L_FROMPORT[i] /
#        L_TOPORT[i] (port dicts)
#
# load_project(path) -> the file as a dict; exits with the error on a problem.

function load_fail(msg) {
	cli_error(msg)
	exit 1
}

# Problems of the file, as LoadError lists them.
function ld_report(msg, line) {
	LD_N++
	LD_MSG[LD_N] = (line ? "Line " line ": " : "") msg
}

function ld_line(d, key) { return ((d, "s" key) in YKLINE) ? YKLINE[d, "s" key] : 0 }
function ld_iline(l, i) { return ((l, i) in YILINE) ? YILINE[l, i] : 0 }

# Line of key `key` of `d`, else `dflt`.
function ld_kl(d, key, dflt,    l) {
	l = ld_line(d, key)
	return l ? l : dflt
}

function ld_throw(    s, i) {
	if (!LD_N) return
	s = ""
	for (i = 1; i <= LD_N; i++) s = s "" (i > 1 ? "\n" : "") LD_MSG[i]
	load_fail(s)
}

function load_project(path, schema,    text, v, i, root_line, k) {
	text = read_file(path)
	if (!FILE_OK) load_fail("cannot read the file")
	LD_FORMAT = tolower(path) ~ /\.json$/ ? "json" : "yaml"
	LD_PARSING = 1
	v = LD_FORMAT == "json" ? json_parse(text, path) : yaml_parse(text, path)
	LD_PARSING = 0
	jsnum(v)
	sc_init(schema)
	root_line = LD_FORMAT == "yaml" ? ld_first_line(text) : 0
	sc_check_file(v, root_line)
	LD_N = 0
	for (i = 1; i <= SC_N; i++) ld_report(SC_MSG[i], SC_LINE[i])
	ld_throw()
	ld_names(v)
	ld_throw()
	return v
}

# Line of the first node of a YAML text (after comments, blank lines, document start).
function ld_first_line(text,    n, a, i) {
	n = split(text, a, "\n")
	for (i = 1; i <= n; i++) if (a[i] !~ /^[ \t]*(#.*)?\r?$/ && a[i] !~ /^(---|%)/) return i
	return 0
}

# ----------------------------------------------------------------- names ----

function ld_names(f,    bins, i, b, deps, d, j, uses, seen, l, x, g, gi, ts, k, consts) {
	LD_ROOT = f
	T_N = I_N = C_N = M_N = X_N = L_N = 0
	delete TYPE_IDX; delete IFACE_IDX; delete M_IDX; delete X_IDX; delete BIN_IDX; delete DEP_IDX
	delete LD_DECL; delete LD_CONSTKEY

	bins = DL(f, "binaries")
	for (i = 0; i < VN[bins]; i++) {
		b = VE[bins, i]
		if (DS(b, "name") in BIN_IDX) ld_report("Duplicate binary '" DS(b, "name") "'", ld_kl(b, "name", ld_iline(bins, i)))
		BIN_IDX[DS(b, "name")] = i
	}
	deps = DL(f, "dependencies")
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		if (DS(d, "name") in DEP_IDX) ld_report("Duplicate dependency '" DS(d, "name") "'", ld_kl(d, "name", ld_iline(deps, i)))
		DEP_IDX[DS(d, "name")] = i
	}
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		uses = DL(d, "uses")
		for (j = 0; j < VN[uses]; j++)
			if (!(v_tostr(VE[uses, j]) in DEP_IDX))
				ld_report("Dependency '" DS(d, "name") "' uses unknown dependency '" v_tostr(VE[uses, j]) "'", ld_iline(uses, j) ? ld_iline(uses, j) : ld_kl(d, "uses", 0))
	}

	# Types (own, of own modules, of dependencies, of their modules) and interfaces share a namespace.
	ts = DL(f, "types")
	for (i = 0; i < VN[ts]; i++) ld_type(VE[ts, i], VE[ts, i] ? DS(VE[ts, i], "name") : "", "", "", "", ld_iline(ts, i))
	ld_module_types(DL(f, "modules"), "")
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		ts = DL(d, "types")
		for (j = 0; j < VN[ts]; j++) ld_type(VE[ts, j], DS(VE[ts, j], "name"), DS(d, "name"), "", "", ld_iline(ts, j))
		g = DL(d, "moduleTypes")
		for (gi = 0; gi < VN[g]; gi++) {
			x = DL(VE[g, gi], "types")
			for (j = 0; j < VN[x]; j++)
				ld_type(VE[x, j], DS(d, "name") "/" DS(VE[g, gi], "module") "." DS(VE[x, j], "name"), DS(d, "name"), "", DS(VE[g, gi], "module"), ld_iline(x, j))
		}
	}
	x = DL(f, "interfaces")
	for (i = 0; i < VN[x]; i++) ld_iface(VE[x, i], "", ld_iline(x, i))
	for (i = 0; i < VN[deps]; i++) {
		x = DL(VE[deps, i], "interfaces")
		for (j = 0; j < VN[x]; j++) ld_iface(VE[x, j], DS(VE[deps, i], "name"), ld_iline(x, j))
	}

	# Constants share the namespace too (those of modules, their module's).
	consts = DL(f, "constants")
	for (i = 0; i < VN[consts]; i++) ld_const(VE[consts, i], DS(VE[consts, i], "name"), "", "", "", ld_iline(consts, i))
	ld_module_consts(DL(f, "modules"), "")
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		x = DL(d, "constants")
		for (j = 0; j < VN[x]; j++) ld_const(VE[x, j], DS(VE[x, j], "name"), DS(d, "name"), "", "", ld_iline(x, j))
		g = DL(d, "moduleConstants")
		for (gi = 0; gi < VN[g]; gi++) {
			x = DL(VE[g, gi], "constants")
			for (j = 0; j < VN[x]; j++)
				ld_const(VE[x, j], DS(d, "name") "/" DS(VE[g, gi], "module") "." DS(VE[x, j], "name"), DS(d, "name"), "", DS(VE[g, gi], "module"), ld_iline(x, j))
		}
	}
	for (i = 1; i <= C_N; i++) {
		k = C_KEY[i]
		if ((k in LD_DECL) || (k in LD_CONSTKEY)) ld_report("Duplicate constant name '" k "'", ld_kl(C_DEF[i], "name", C_LINE[i]))
		LD_CONSTKEY[k] = i
	}

	# References of the types, constants and interfaces.
	for (i = 1; i <= T_N; i++) ld_type_refs(T_DEF[i], T_LINE[i])
	for (i = 1; i <= C_N; i++) ld_ref(D(C_DEF[i], "type"), C_KEY[i], ld_kl(C_DEF[i], "type", C_LINE[i]))
	for (i = 1; i <= I_N; i++) ld_messages(DL(I_DEF[i], "messages"), DS(I_DEF[i], "name"))

	ld_modules(DL(f, "modules"), "", "")
	for (i = 1; i <= M_N; i++) ld_bases(i)
	for (i = 1; i <= C_N; i++) if (C_MOD[i] != "" && (C_MOD[i] in M_IDX)) C_MODOK[i] = 1
	ld_placed(deps)

	l = DL(f, "links")
	for (i = 0; i < VN[l]; i++) {
		x = VE[l, i]
		L_N++
		L_DEF[L_N] = x
		L_FROM[L_N] = ld_endpoint(D(x, "from"), "Link '" DS(x, "name") "' from", "from", L_N, ld_kl(x, "from", ld_iline(l, i)))
		L_TO[L_N] = ld_endpoint(D(x, "to"), "Link '" DS(x, "name") "' to", "to", L_N, ld_kl(x, "to", ld_iline(l, i)))
	}
}

function ld_declare(key, what, line) {
	if (key in LD_DECL) ld_report("Duplicate " what " name '" key "'", line)
	LD_DECL[key] = what
}

function ld_type(t, key, dep, mod, modpath, line) {
	T_N++
	T_KEY[T_N] = key
	T_DEF[T_N] = t
	T_DEP[T_N] = dep
	T_MOD[T_N] = mod
	T_MODPATH[T_N] = modpath
	T_LINE[T_N] = line
	ld_declare(key, "type", ld_kl(t, "name", line))
	TYPE_IDX[key] = T_N
}

function ld_module_types(list, parent,    i, m, path, ts, j) {
	for (i = 0; i < VN[list]; i++) {
		m = VE[list, i]
		path = parent != "" ? parent "." DS(m, "name") : DS(m, "name")
		ts = DL(m, "types")
		for (j = 0; j < VN[ts]; j++) ld_type(VE[ts, j], path "." DS(VE[ts, j], "name"), "", path, "", ld_iline(ts, j))
		ld_module_types(DL(m, "modules"), path)
	}
}

function ld_module_consts(list, parent,    i, m, path, cs, j) {
	for (i = 0; i < VN[list]; i++) {
		m = VE[list, i]
		path = parent != "" ? parent "." DS(m, "name") : DS(m, "name")
		cs = DL(m, "constants")
		for (j = 0; j < VN[cs]; j++) ld_const(VE[cs, j], path "." DS(VE[cs, j], "name"), "", path, "", ld_iline(cs, j))
		ld_module_consts(DL(m, "modules"), path)
	}
}

function ld_const(c, key, dep, mod, modpath, line) {
	C_N++
	C_KEY[C_N] = key
	C_DEF[C_N] = c
	C_DEP[C_N] = dep
	C_MOD[C_N] = mod
	C_MODPATH[C_N] = modpath
	C_LINE[C_N] = line
}

function ld_iface(x, dep, line) {
	I_N++
	I_DEF[I_N] = x
	I_DEP[I_N] = dep
	ld_declare(DS(x, "name"), "interface", ld_kl(x, "name", line))
	IFACE_IDX[DS(x, "name")] = I_N
}

# A type reference: every user type it names must be a type (not an interface).
function ld_ref(t, where, line,    k, name) {
	if (!t || VT[t] != "dict") return
	k = DS(t, "kind")
	if (k == "ref") {
		name = DS(t, "name")
		if (!(name in TYPE_IDX) || (name in IFACE_IDX)) ld_report(where ": unknown type '" name "'", line)
	} else if (k == "map") {
		ld_ref(D(t, "key"), where, line)
		ld_ref(D(t, "value"), where, line)
	} else if (k != "primitive") ld_ref(D(t, "of"), where, line)
}

function ld_fields(list, where,    i, x) {
	for (i = 0; i < VN[list]; i++) {
		x = VE[list, i]
		ld_ref(D(x, "type"), where "." DS(x, "name"), ld_kl(x, "type", ld_iline(list, i)))
	}
}

function ld_type_refs(t, line,    k, name) {
	k = DS(t, "kind")
	name = DS(t, "name")
	if (k == "struct" || k == "exception") ld_fields(DL(t, "fields"), name)
	else if (k == "union") {
		ld_ref(D(t, "discriminator"), name " discriminator", ld_kl(t, "discriminator", line))
		ld_fields(DL(t, "cases"), name)
	} else if (k == "alias") ld_ref(D(t, "type"), name, ld_kl(t, "type", line))
}

# Messages of an interface or methods of a module (`owner`).
function ld_messages(list, owner,    i, m, where, ps, j, p, rs, r, line) {
	for (i = 0; i < VN[list]; i++) {
		m = VE[list, i]
		where = owner "." DS(m, "name")
		line = ld_iline(list, i)
		ps = DL(m, "params")
		for (j = 0; j < VN[ps]; j++) {
			p = VE[ps, j]
			ld_ref(D(p, "type"), where "." DS(p, "name"), ld_kl(p, "type", ld_iline(ps, j)))
		}
		if (DH(m, "returns")) ld_ref(D(m, "returns"), where " returns", ld_kl(m, "returns", line))
		rs = DL(m, "raises")
		for (j = 0; j < VN[rs]; j++) {
			r = v_tostr(VE[rs, j])
			if (!(r in TYPE_IDX) || (r in IFACE_IDX)) ld_report(where " raises: unknown exception '" r "'", ld_iline(rs, j) ? ld_iline(rs, j) : ld_kl(m, "raises", line))
		}
	}
}

function ld_attributes(list, path,    i) {
	ld_fields(list, path)
}

function ld_modules(list, parent, parent_path,    i, m, path, seen, ports, j, pt, pnames, line, iname, b) {
	delete seen
	for (i = 0; i < VN[list]; i++) {
		m = VE[list, i]
		path = parent_path != "" ? parent_path "." DS(m, "name") : DS(m, "name")
		line = ld_iline(list, i)
		if (("x" DS(m, "name")) in seen) ld_report("Duplicate module '" path "'", ld_kl(m, "name", line))
		seen["x" DS(m, "name")] = 1
		M_N++
		M_PATH[M_N] = path
		M_DEF[M_N] = m
		M_PARENT[M_N] = parent_path
		M_BIN[M_N] = ""
		M_IDX[path] = M_N
		# deprecated: the color of the module in the editor's style
		if (!DH(m, "color") && DH(D(D(D(LD_ROOT, "editor"), "style"), path), "color"))
			set(m, "color", D(D(D(D(LD_ROOT, "editor"), "style"), path), "color"))
		ld_attributes(DL(m, "attributes"), path)
		ld_messages(DL(m, "methods"), path)
		ports = DL(m, "ports")
		delete pnames
		for (j = 0; j < VN[ports]; j++) {
			pt = VE[ports, j]
			if (("x" DS(pt, "name")) in pnames) ld_report("Duplicate port '" path ":" DS(pt, "name") "'", ld_kl(pt, "name", ld_iline(ports, j)))
			pnames["x" DS(pt, "name")] = 1
			iname = DS(pt, "interface")
			if (iname != "" && !(iname in IFACE_IDX))
				ld_report("Port '" path ":" DS(pt, "name") "': unknown interface '" iname "'", ld_kl(pt, "interface", ld_iline(ports, j)))
		}
		if (DS(m, "binary") != "") {
			b = DS(m, "binary")
			if (parent_path != "") ld_report("Module '" path "': only top-level modules name their binary", ld_kl(m, "binary", line))
			else if (!(b in BIN_IDX)) ld_report("Module '" path "': unknown binary '" b "'", ld_kl(m, "binary", line))
			else M_BIN[M_N] = b
		}
		ld_modules(DL(m, "modules"), M_N, path)
	}
}

function ld_bases(i,    m, bases, j, b, s) {
	m = M_DEF[i]
	bases = DL(m, "bases")
	s = ""
	for (j = 0; j < VN[bases]; j++) {
		b = v_tostr(VE[bases, j])
		if (!(b in M_IDX)) ld_report("Module '" M_PATH[i] "': unknown base '" b "'", ld_iline(bases, j) ? ld_iline(bases, j) : ld_kl(m, "bases", 0))
		else s = s "" (s == "" ? "" : " ") b
	}
	M_BASES[i] = s
}

# Placed modules of dependencies.
function ld_placed(deps,    i, d, ms, j, m, where, seen, ports, k, pt, pnames, key) {
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		ms = DL(d, "modules")
		delete seen
		for (j = 0; j < VN[ms]; j++) {
			m = VE[ms, j]
			where = "Dependency '" DS(d, "name") "' module '" DS(m, "module") "'"
			if (("x" DS(m, "module")) in seen) ld_report(where ": listed more than once", ld_kl(m, "module", ld_iline(ms, j)))
			seen["x" DS(m, "module")] = 1
			key = DS(d, "name") "/" DS(m, "module")
			X_N++
			X_DEP[X_N] = DS(d, "name")
			X_PATH[X_N] = DS(m, "module")
			X_DEF[X_N] = m
			X_IDX[key] = X_N
			ld_fields(DL(m, "attributes"), key)
			ld_messages(DL(m, "methods"), key)
			ports = DL(m, "ports")
			delete pnames
			for (k = 0; k < VN[ports]; k++) {
				pt = VE[ports, k]
				if (("x" DS(pt, "name")) in pnames) ld_report(where ": duplicate port '" DS(pt, "name") "'", ld_kl(pt, "name", ld_iline(ports, k)))
				pnames["x" DS(pt, "name")] = 1
			}
		}
	}
}

# Module id of a link end ("" when unknown); its port in L_FROMPORT / L_TOPORT.
function ld_endpoint(e, where, side, n, line,    proj, mod, port, x, key) {
	mod = DS(e, "module")
	port = DS(e, "port")
	if (DH(e, "project")) {
		proj = DS(e, "project")
		key = proj "/" mod
		if (!(proj in DEP_IDX)) { ld_report(where ": unknown dependency '" proj "'", ld_kl(e, "project", line)); return "" }
		if (!(key in X_IDX)) { ld_report(where ": module '" mod "' is not placed from dependency '" proj "'", ld_kl(e, "module", line)); return "" }
		x = ld_port_of(X_DEF[X_IDX[key]], port)
		if (!x) { ld_report(where ": unknown port '" proj "/" mod ":" port "'", ld_kl(e, "port", line)); return "" }
		if (side == "from") L_FROMPORT[n] = x
		else L_TOPORT[n] = x
		return key
	}
	if (!(mod in M_IDX)) { ld_report(where ": unknown module '" mod "'", ld_kl(e, "module", line)); return "" }
	x = ld_port_of(M_DEF[M_IDX[mod]], port)
	if (!x) { ld_report(where ": unknown port '" mod ":" port "'", ld_kl(e, "port", line)); return "" }
	if (side == "from") L_FROMPORT[n] = x
	else L_TOPORT[n] = x
	return mod
}

function ld_port_of(m, name,    ps, i) {
	ps = DL(m, "ports")
	for (i = 0; i < VN[ps]; i++) if (DS(VE[ps, i], "name") == name) return VE[ps, i]
	return 0
}
