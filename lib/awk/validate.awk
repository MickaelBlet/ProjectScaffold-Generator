# validate.awk - semantic checks of a loaded project (src/model/validate.ts), errors only: they
# block generation (warnings are the editor's). In the order of the editor's checks, after
# load.awk (whose tables it reads): the errors load.awk already rules out are not checked again.
#
#   validate() -> number of errors, in VAL_MSG[1..n]

function val_err(msg) { VAL_MSG[++VAL_N] = msg }

function reserved_type_name(n) {
	return n ~ /^(bool|char|u?int(8|16|32|64)|float32|float64|string|bytes|array|vector|list|set|optional|map)$/
}

# Names of a list of dicts (key `k`) occurring more than once, in VDUP[1..n], in the order they repeat.
function dups(list, k,    n, i, s, seen, out) {
	n = 0
	for (i = 0; i < VN[list]; i++) {
		s = DS(VE[list, i], k)
		if (("x" s) in seen) {
			if (!(("x" s) in out)) { out["x" s] = 1; VDUP[++n] = s }
		} else seen["x" s] = 1
	}
	return n
}

# Same, for the strings S[1..count].
function dups_of(count,    n, i, seen, out) {
	n = 0
	for (i = 1; i <= count; i++) {
		if (("x" S[i]) in seen) {
			if (!(("x" S[i]) in out)) { out["x" S[i]] = 1; VDUP[++n] = S[i] }
		} else seen["x" S[i]] = 1
	}
	return n
}

function type_def(key) { return (key in TYPE_IDX) ? T_DEF[TYPE_IDX[key]] : 0 }

# Errors of the nodes of a type reference.
function check_typeref(t, where,    k, def, kk, keyof) {
	if (!t || VT[t] != "dict") return
	k = DS(t, "kind")
	if (k == "ref") {
		def = type_def(DS(t, "name"))
		if (def && DS(def, "kind") == "exception") val_err(where ": exception '" DS(def, "name") "' can only be raised")
	}
	if (k == "primitive" && DH(t, "max") && DS(t, "name") != "string" && DS(t, "name") != "bytes")
		val_err(where ": " DS(t, "name") " cannot be bounded")
	keyof = k == "map" ? D(t, "key") : k == "set" ? D(t, "of") : 0
	if (keyof) {
		vresolve(keyof)
		if (VRS_KIND != "") {
			kk = VRS_KIND == "def" ? DS(VRS_DEF, "kind") : VRS_KIND
			if (kk != "primitive" && kk != "enum" && kk != "bitmask")
				val_err(where ": " k " key must be a primitive, an enum or a bitmask")
		}
	}
	if (k == "map") {
		check_typeref(D(t, "key"), where)
		check_typeref(D(t, "value"), where)
	} else if (k != "primitive" && k != "ref") check_typeref(D(t, "of"), where)
}

function check_default(f, where,    n, i) {
	if (!D(f, "default")) return
	n = value_errors(D(f, "default"), D(f, "type"))
	for (i = 1; i <= n; i++) val_err(where " default: " VE_MSG[i])
}

# Kind after aliases of a reference ("" for deleted / cyclic): enum, primitive name...
function resolved_kind(t) {
	vresolve(t)
	if (VRS_KIND == "def") return DS(VRS_DEF, "kind")
	return VRS_KIND
}

function check_message(m, where,    n, i, ps, p, rs, r, def) {
	ps = DL(m, "params")
	n = dups(ps, "name")
	for (i = 1; i <= n; i++) val_err(where ": duplicate parameter '" VDUP[i] "'")
	for (i = 0; i < VN[ps]; i++) check_typeref(D(VE[ps, i], "type"), where "(" DS(VE[ps, i], "name") ")")
	if (DH(m, "returns")) check_typeref(D(m, "returns"), where " returns")
	rs = DL(m, "raises")
	for (i = 0; i < VN[rs]; i++) {
		def = type_def(v_tostr(VE[rs, i]))
		if (def && DS(def, "kind") != "exception") val_err(where " raises '" DS(def, "name") "', which is not an exception")
	}
	for (i = 0; i < VN[rs]; i++) S[i + 1] = v_tostr(VE[rs, i])
	n = dups_of(VN[rs])
	for (i = 1; i <= n; i++) val_err(where " raises '" DS(type_def(VDUP[i]), "name") "' more than once")
}

# ------------------------------------------------------------- modules ----

# Bases of module i, direct and indirect, nearest first, each once: ANC[1..n] (module indexes).
function ancestors(i,    seen, level, nl, next_, nn, j, b, n, k, parts, c) {
	n = 0
	seen[i] = 1
	nl = 1
	level[1] = i
	while (nl) {
		nn = 0
		for (j = 1; j <= nl; j++) {
			c = split(M_BASES[level[j]], parts, " ")
			for (k = 1; k <= c; k++) {
				b = M_IDX[parts[k]]
				if (b in seen) continue
				seen[b] = 1
				ANC[++n] = b
				next_[++nn] = b
			}
		}
		delete level
		for (j = 1; j <= nn; j++) level[j] = next_[j]
		delete next_
		nl = nn
	}
	return n
}

function is_ancestor(i, a,    n, j) {
	n = ancestors(i)
	for (j = 1; j <= n; j++) if (ANC[j] == a) return 1
	return 0
}

# Text of a type reference (typeExpr.ts printTypeExpr).
function type_expr(t,    k) {
	k = DS(t, "kind")
	if (k == "primitive") return DH(t, "max") ? DS(t, "name") "<" DS(t, "max") ">" : DS(t, "name")
	if (k == "ref") return DS(t, "name")
	if (k == "array") return "array<" type_expr(D(t, "of")) ", " DS(t, "size") ">"
	if (k == "map") return "map<" type_expr(D(t, "key")) ", " type_expr(D(t, "value")) (DH(t, "max") ? ", " DS(t, "max") : "") ">"
	if (k == "optional") return "optional<" type_expr(D(t, "of")) ">"
	return k "<" type_expr(D(t, "of")) (DH(t, "max") ? ", " DS(t, "max") : "") ">"
}

function method_signature(m,    ps, i, p, s) {
	ps = DL(m, "params")
	s = ""
	for (i = 0; i < VN[ps]; i++) {
		p = VE[ps, i]
		s = s "" (i ? ", " : "") (DH(p, "direction") ? DS(p, "direction") : "in") " " (DB(p, "const") ? "const " : "") type_expr(D(p, "type"))
	}
	return "(" s ")" (DH(m, "returns") ? type_expr(D(m, "returns")) : "") (DB(m, "const") ? " const" : "")
}

function module_kind(i,    k) {
	k = DS(M_DEF[i], "kind")
	return k == "class" ? "" : k
}

# Pure methods module i inherits and does not implement: UN_BASE[1..n] (module index), UN_NAME.
function unimplemented(i,    defined) {
	UN_N = 0
	delete UN_SEEN
	ms_names(i, defined, 0)
	un_walk(i, defined, "|" i "|")
	return UN_N
}

# Adds the names of the methods of module i (pure ones only when `pure` is 1, none of them when 0... see callers) to arr.
function ms_names(i, arr, nonpure_only,    ms, j) {
	ms = DL(M_DEF[i], "methods")
	for (j = 0; j < VN[ms]; j++) if (!nonpure_only || !DB(VE[ms, j], "pure")) arr[DS(VE[ms, j], "name")] = 1
}

function un_walk(cur, defined, stack,    c, parts, k, b, ms, j, x, names, n) {
	c = split(M_BASES[cur], parts, " ")
	for (k = 1; k <= c; k++) {
		b = M_IDX[parts[k]]
		if (index(stack, "|" b "|")) continue
		ms = DL(M_DEF[b], "methods")
		for (j = 0; j < VN[ms]; j++) {
			x = VE[ms, j]
			if (DB(x, "pure") && !(DS(x, "name") in defined) && !(DS(x, "name") in UN_SEEN)) {
				UN_SEEN[DS(x, "name")] = 1
				UN_N++
				UN_BASE[UN_N] = b
				UN_NAME[UN_N] = DS(x, "name")
			}
		}
		delete names
		for (n in defined) names[n] = 1
		ms_names(b, names, 1)
		un_walk(b, names, stack b "|")
	}
}

# Binary a module id runs in ("" none; imported modules: none).
function binary_of(id,    i) {
	if (!(id in M_IDX)) return ""
	i = M_IDX[id]
	while (M_PARENT[i] != "") i = M_IDX[M_PARENT[i]]
	return M_BIN[i]
}

# ---------------------------------------------------------------- refs ----

# Every type reference of the project, in the editor's order: AR_REF[i], AR_WHERE[i],
# AR_OWNER[i] (type:<n>, const:<n>, interface:<n>, module:<n>), AR_DEP[i] (dependency of the owner).
function all_type_refs(    i, t, k, key, fs, j, x, ms, m, ps, p, rs, path, as, n) {
	AR_N = 0
	for (i = 1; i <= T_N; i++) {
		t = T_DEF[i]
		k = DS(t, "kind")
		key = T_KEY[i]
		if (k == "struct" || k == "exception") {
			fs = DL(t, "fields")
			for (j = 0; j < VN[fs]; j++) ar_add(D(VE[fs, j], "type"), key "." DS(VE[fs, j], "name"), "type:" i, T_DEP[i])
		}
		if (k == "alias") ar_add(D(t, "type"), key, "type:" i, T_DEP[i])
		if (k == "union") {
			ar_add(D(t, "discriminator"), key " discriminator", "type:" i, T_DEP[i])
			fs = DL(t, "cases")
			for (j = 0; j < VN[fs]; j++) ar_add(D(VE[fs, j], "type"), key "." DS(VE[fs, j], "name"), "type:" i, T_DEP[i])
		}
	}
	for (i = 1; i <= C_N; i++) ar_add(D(C_DEF[i], "type"), C_KEY[i], "const:" i, C_DEP[i])
	for (i = 1; i <= I_N; i++) {
		ms = DL(I_DEF[i], "messages")
		for (j = 0; j < VN[ms]; j++) ar_message(VE[ms, j], DS(I_DEF[i], "name") "." DS(VE[ms, j], "name"), "interface:" i, I_DEP[i])
	}
	for (i = 1; i <= M_N; i++) {
		path = M_PATH[i]
		as = DL(M_DEF[i], "attributes")
		for (j = 0; j < VN[as]; j++) ar_add(D(VE[as, j], "type"), path "." DS(VE[as, j], "name"), "module:" i, "")
		ms = DL(M_DEF[i], "methods")
		for (j = 0; j < VN[ms]; j++) ar_message(VE[ms, j], path "." DS(VE[ms, j], "name"), "module:" i, "")
	}
}

function ar_add(t, where, owner, dep) {
	AR_N++
	AR_REF[AR_N] = t
	AR_WHERE[AR_N] = where
	AR_OWNER[AR_N] = owner
	AR_DEP[AR_N] = dep
}

function ar_message(m, where, owner, dep,    ps, i, rs, r) {
	ps = DL(m, "params")
	for (i = 0; i < VN[ps]; i++) ar_add(D(VE[ps, i], "type"), where "(" DS(VE[ps, i], "name") ")", owner, dep)
	if (DH(m, "returns")) ar_add(D(m, "returns"), where " returns", owner, dep)
	rs = DL(m, "raises")
	for (i = 0; i < VN[rs]; i++) {
		r = v_dict()
		set(r, "kind", v_str("ref"))
		set(r, "name", VE[rs, i])
		ar_add(r, where " raises", owner, dep)
	}
}

# Keys of the user types a reference names, in RK[1..n] (pre-order).
function ref_keys(t, n,    k) {
	k = DS(t, "kind")
	if (k == "ref") { RK[++n] = DS(t, "name"); return n }
	if (k == "map") return ref_keys(D(t, "value"), ref_keys(D(t, "key"), n))
	if (k != "primitive") return ref_keys(D(t, "of"), n)
	return n
}

# Module (index) whose scope a reference of `owner` is in: 0 outside modules.
function ref_context(owner,    kind, i) {
	kind = owner
	sub(/:.*/, "", kind)
	i = substr(owner, length(kind) + 2) + 0
	if (kind == "module") return i
	if (kind == "type") return T_MOD[i] != "" ? M_IDX[T_MOD[i]] : 0
	if (kind == "const") return C_MOD[i] != "" && (C_MOD[i] in M_IDX) ? M_IDX[C_MOD[i]] : 0
	return 0
}

function type_access(i,    a) {
	a = DS(T_DEF[i], "access")
	return a == "protected" || a == "private" ? a : ""
}

# Whether modules (context: module index, 0 outside them) may use type i.
function can_use_type(context, i,    a) {
	if ((T_MOD[i] == "" && T_MODPATH[i] == "") || type_access(i) == "") return 1
	if (!context || T_MOD[i] == "") return 0
	if (M_IDX[T_MOD[i]] == context) return 1
	return type_access(i) == "protected" && is_ancestor(context, M_IDX[T_MOD[i]])
}

# Dependencies (names) whose entities those of dependency `d` may use, in REACH[name].
function reach(d,    deps, x, uses, j) {
	if (d in REACH) return
	REACH[d] = 1
	deps = DL(LD_ROOT, "dependencies")
	x = VE[deps, DEP_IDX[d]]
	uses = DL(x, "uses")
	for (j = 0; j < VN[uses]; j++) if (v_tostr(VE[uses, j]) in DEP_IDX) reach(v_tostr(VE[uses, j]))
}

# File path normalized (sync.ts normalizeFile).
function normalize_file(f,    parts, n, i, out, o, p) {
	n = split(f, parts, /[\\\/]/)
	o = 0
	for (i = 1; i <= n; i++) {
		p = parts[i]
		if (p == "." || (p == "" && o)) continue
		if (p == ".." && o && out[o] != ".." && out[o] != "") o--
		else out[++o] = p
	}
	p = ""
	for (i = 1; i <= o; i++) p = p "" (i > 1 ? "/" : "") out[i]
	return p
}

# ------------------------------------------------------------ validate ----

function validate(    i, j, n, t, k, name, fs, f, c, vals, x, w, ms, m, deps, d, uses, u, l, from, to, key, def, used, ctx, of, ok, labels, cs, lab, ndef, dk, valid, all, every, members, as, ps, p, inh, a, b, sig, links, lf, lt, fp, tp, fr, tr, foreign, fi, ti, fiface, cc, s, bf, bt, transport, settings, nm, lst, edges) {
	VAL_N = 0
	# Constants
	for (i = 1; i <= C_N; i++) {
		c = C_DEF[i]
		if (reserved_type_name(DS(c, "name"))) val_err("'" DS(c, "name") "' is a reserved type name")
		check_typeref(D(c, "type"), C_KEY[i])
		n = value_errors(DN(c, "value"), D(c, "type"))
		for (j = 1; j <= n; j++) val_err("Constant '" C_KEY[i] "': " VE_MSG[j])
	}
	# Types
	for (i = 1; i <= T_N; i++) {
		t = T_DEF[i]
		name = DS(t, "name")
		k = DS(t, "kind")
		if (reserved_type_name(name)) val_err("'" name "' is a reserved type name")
		if (k == "struct" || k == "exception") {
			fs = DL(t, "fields")
			n = dups(fs, "name")
			for (j = 1; j <= n; j++) val_err((k == "struct" ? "Struct" : "Exception") " '" name "': duplicate field '" VDUP[j] "'")
			for (j = 0; j < VN[fs]; j++) {
				f = VE[fs, j]
				check_typeref(D(f, "type"), name "." DS(f, "name"))
				check_default(f, name "." DS(f, "name"))
			}
		} else if (k == "enum") {
			vals = DL(t, "values")
			n = dups(vals, "name")
			for (j = 1; j <= n; j++) val_err("Enum '" name "': duplicate value name '" VDUP[j] "'")
			int_range(DS(t, "underlying"))
			for (j = 0; j < VN[vals]; j++) {
				x = to_bigint(D(VE[vals, j], "value"))
				if (bi_cmp(x, VR_MIN) < 0 || bi_cmp(x, VR_MAX) > 0)
					val_err("Enum '" name "': " DS(VE[vals, j], "name") " = " js_str(D(VE[vals, j], "value")) " does not fit in " DS(t, "underlying"))
			}
		} else if (k == "bitmask") {
			vals = DL(t, "flags")
			n = dups(vals, "name")
			for (j = 1; j <= n; j++) val_err("Bitmask '" name "': duplicate flag '" VDUP[j] "'")
			for (j = 0; j < VN[vals]; j++) S[j + 1] = js_str(D(VE[vals, j], "bit"))
			n = dups_of(VN[vals])
			for (j = 1; j <= n; j++) val_err("Bitmask '" name "': bit " VDUP[j] " used more than once")
			w = substr(DS(t, "underlying"), 5) + 0
			for (j = 0; j < VN[vals]; j++)
				if (DS(VE[vals, j], "bit") + 0 >= w)
					val_err("Bitmask '" name "': " DS(VE[vals, j], "name") " (bit " DS(VE[vals, j], "bit") ") does not fit in " DS(t, "underlying"))
		} else if (k == "union") {
			check_typeref(D(t, "discriminator"), name " discriminator")
			dk = resolved_kind(D(t, "discriminator"))
			valid = dk == "enum" || (VRS_KIND == "primitive" && (DS(VRS_REF, "name") == "bool" || DS(VRS_REF, "name") == "char" || is_int_primitive(DS(VRS_REF, "name"))))
			if (dk != "" && !valid) val_err("Union '" name "': discriminator must be an integer, bool, char or enum")
			cs = DL(t, "cases")
			n = dups(cs, "name")
			for (j = 1; j <= n; j++) val_err("Union '" name "': duplicate case '" VDUP[j] "'")
			ndef = 0
			for (j = 0; j < VN[cs]; j++) if (DB(VE[cs, j], "default")) ndef++
			if (ndef > 1) val_err("Union '" name "': more than one default case")
			for (j = 0; j < VN[cs]; j++) {
				c = VE[cs, j]
				check_typeref(D(c, "type"), name "." DS(c, "name"))
				labels = DL(c, "labels")
				if (!VN[labels] && !DB(c, "default")) val_err("Union '" name "': case '" DS(c, "name") "' has no label")
				if (valid)
					for (x = 0; x < VN[labels]; x++) {
						n = value_errors(VE[labels, x], D(t, "discriminator"))
						for (w = 1; w <= n; w++) val_err("Union '" name "': label of case '" DS(c, "name") "': " VE_MSG[w])
					}
			}
			n = 0
			for (j = 0; j < VN[cs]; j++) {
				labels = DL(VE[cs, j], "labels")
				for (x = 0; x < VN[labels]; x++) S[++n] = js_str(VE[labels, x])
			}
			n = dups_of(n)
			for (j = 1; j <= n; j++) val_err("Union '" name "': label " VDUP[j] " used by several cases")
		} else if (k == "alias") {
			check_typeref(D(t, "type"), name)
			x = D(t, "type")
			if (DS(x, "kind") == "ref" && (DS(x, "name") in TYPE_IDX) && alias_cyclic(T_KEY[i], x))
				val_err("Alias '" name "' is cyclic")
		}
	}
	by_value_cycles()

	# Interfaces
	for (i = 1; i <= I_N; i++) {
		x = I_DEF[i]
		name = DS(x, "name")
		if (reserved_type_name(name)) val_err("'" name "' is a reserved type name")
		ms = DL(x, "messages")
		n = dups(ms, "name")
		for (j = 1; j <= n; j++) val_err("Interface '" name "': duplicate message '" VDUP[j] "'")
		for (j = 0; j < VN[ms]; j++) check_message(VE[ms, j], name "." DS(VE[ms, j], "name"))
	}

	# Modules
	for (i = 1; i <= M_N; i++) validate_module(i)

	# Dependencies
	deps = DL(LD_ROOT, "dependencies")
	for (i = 0; i < VN[deps]; i++) S[i + 1] = normalize_file(DS(VE[deps, i], "file"))
	n = dups_of(VN[deps])
	for (j = 1; j <= n; j++) val_err("Dependency file '" VDUP[j] "' listed more than once")
	for (i = 0; i < VN[deps]; i++) {
		d = VE[deps, i]
		uses = DL(d, "uses")
		ok = 0
		for (j = 0; j < VN[uses]; j++) {
			u = v_tostr(VE[uses, j])
			if (!(u in DEP_IDX)) continue
			delete REACH
			reach(u)
			if (DS(d, "name") in REACH) ok = 1
		}
		if (ok) val_err("Dependency '" DS(d, "name") "' uses itself through other dependencies")
	}

	# Types of modules: public ones anywhere, the others in modules only, as their access allows.
	all_type_refs()
	for (i = 1; i <= AR_N; i++) {
		if (AR_DEP[i] != "") continue
		ctx = ref_context(AR_OWNER[i])
		n = ref_keys(AR_REF[i], 0)
		for (j = 1; j <= n; j++) {
			if (!(RK[j] in TYPE_IDX)) continue
			used = TYPE_IDX[RK[j]]
			if (T_MOD[used] == "" && T_MODPATH[used] == "") continue
			of = T_MOD[used] != "" ? T_MOD[used] : T_MODPATH[used]
			if (!ctx && !can_use_type(0, used))
				val_err(AR_WHERE[i] ": '" T_KEY[used] "' is a " type_access(used) " type of module " of ", used by modules only")
			else if (!can_use_type(ctx, used))
				val_err(AR_WHERE[i] ": '" T_KEY[used] "' is " (type_access(used) != "" ? type_access(used) : "public") " in " of)
		}
	}
	for (i = 1; i <= AR_N; i++) {
		x = AR_OWNER[i]
		if (x ~ /^module:/ || AR_DEP[i] == "") continue
		delete REACH
		reach(AR_DEP[i])
		delete SHARED
		for (j = 0; j < VN[deps]; j++)
			if (DS(VE[deps, j], "name") in REACH) {
				lst = DL(VE[deps, j], "shared")
				for (k = 0; k < VN[lst]; k++) SHARED[v_tostr(VE[lst, k])] = 1
			}
		n = ref_keys(AR_REF[i], 0)
		for (j = 1; j <= n; j++) {
			if (!(RK[j] in TYPE_IDX)) continue
			used = TYPE_IDX[RK[j]]
			nm = DS(T_DEF[used], "name")
			if ((T_DEP[used] == "" || !(T_DEP[used] in REACH)) && !(nm in SHARED))
				val_err(AR_WHERE[i] ": '" nm "' is not in its dependency or the dependencies it uses")
		}
	}

	validate_links()
	return VAL_N
}

# Whether following the alias at `key` (reference x) comes back to a seen alias or a deleted type.
function alias_cyclic(key, x,    seen, def) {
	seen[key] = 1
	while (DS(x, "kind") == "ref") {
		if (!(DS(x, "name") in TYPE_IDX) || (DS(x, "name") in seen)) return 1
		def = T_DEF[TYPE_IDX[DS(x, "name")]]
		if (DS(def, "kind") != "alias") return 0
		seen[DS(x, "name")] = 1
		x = D(def, "type")
	}
	return 0
}

# Structs and unions containing themselves by value (through fields, cases, arrays, optionals, aliases).
function by_value(t, from,    k, key, def, i) {
	k = DS(t, "kind")
	if (k == "array" || k == "optional") return by_value(D(t, "of"), from)
	if (k != "ref") return
	key = DS(t, "name")
	if (!(key in TYPE_IDX)) return
	i = TYPE_IDX[key]
	def = T_DEF[i]
	if (DS(def, "kind") == "struct" || DS(def, "kind") == "union") {
		if (!((from, i) in EDGE)) {
			EDGE[from, i] = 1
			EDGES[from] = EDGES[from] " " i
		}
	} else if (DS(def, "kind") == "alias" && !(key in BV_SEEN)) {
		BV_SEEN[key] = 1
		by_value(D(def, "type"), from)
	}
}

function by_value_cycles(    i, k, fs, j, n) {
	delete EDGE
	delete EDGES
	delete BV_STATE
	delete CYCLIC
	CYC_N = 0
	for (i = 1; i <= T_N; i++) {
		k = DS(T_DEF[i], "kind")
		if (k != "struct" && k != "union") continue
		EDGES[i] = ""
		fs = DL(T_DEF[i], k == "struct" ? "fields" : "cases")
		for (j = 0; j < VN[fs]; j++) {
			delete BV_SEEN
			by_value(D(VE[fs, j], "type"), i)
		}
	}
	for (i = 1; i <= T_N; i++) if (i in EDGES) bv_visit(i, "")
	for (n = 1; n <= CYC_N; n++) {
		i = CYC[n]
		val_err((DS(T_DEF[i], "kind") == "union" ? "Union" : "Struct") " '" DS(T_DEF[i], "name") "' contains itself by value (use vector, list, map or set to break the cycle)")
	}
}

# stack: type indexes separated by spaces
function bv_visit(id, stack,    parts, n, j, from, nexts) {
	if (BV_STATE[id] == "done") return
	if (BV_STATE[id] == "visiting") {
		n = split(stack, parts, " ")
		from = 0
		for (j = 1; j <= n; j++) if (parts[j] == id) { from = j; break }
		for (j = from; j <= n; j++) if (!(parts[j] in CYCLIC)) { CYCLIC[parts[j]] = 1; CYC[++CYC_N] = parts[j] }
		return
	}
	BV_STATE[id] = "visiting"
	n = split(EDGES[id], nexts, " ")
	for (j = 1; j <= n; j++) bv_visit(nexts[j], stack " " id)
	BV_STATE[id] = "done"
}

function validate_module(i,    m, path, kind, members, n, j, x, own, as, ms, attrs, a, where, inh, sig, bases, parts, c, self_, ps, p, nb) {
	m = M_DEF[i]
	path = M_PATH[i]
	kind = module_kind(i)
	if (DL(LD_ROOT, "binaries") && VN[DL(LD_ROOT, "binaries")] && M_PARENT[i] == "" && M_BIN[i] == "")
		val_err(path ": runs in no binary (the project has binaries)")
	# types and constants of the module vs its members and submodules
	delete members
	as = DL(m, "attributes")
	for (j = 0; j < VN[as]; j++) members[DS(VE[as, j], "name")] = 1
	ms = DL(m, "methods")
	for (j = 0; j < VN[ms]; j++) members[DS(VE[ms, j], "name")] = 1
	x = DL(m, "ports")
	for (j = 0; j < VN[x]; j++) members[DS(VE[x, j], "name")] = 1
	x = DL(m, "modules")
	for (j = 0; j < VN[x]; j++) members[DS(VE[x, j], "name")] = 1
	for (j = 1; j <= T_N; j++)
		if (T_MOD[j] == path && (DS(T_DEF[j], "name") in members))
			val_err(path ": '" DS(T_DEF[j], "name") "' is both a type or constant and a member or submodule")
	for (j = 1; j <= C_N; j++)
		if (C_MOD[j] == path && (DS(C_DEF[j], "name") in members))
			val_err(path ": '" DS(C_DEF[j], "name") "' is both a type or constant and a member or submodule")
	n = dups(as, "name")
	for (j = 1; j <= n; j++) val_err(path ": duplicate attribute '" VDUP[j] "'")
	for (j = 0; j < VN[as]; j++) {
		a = VE[as, j]
		check_typeref(D(a, "type"), path "." DS(a, "name"))
		check_default(a, path "." DS(a, "name"))
	}
	n = dups(ms, "name")
	for (j = 1; j <= n; j++) val_err(path ": duplicate method '" VDUP[j] "'")
	delete attrs
	for (j = 0; j < VN[as]; j++) attrs[DS(VE[as, j], "name")] = 1
	nb = ancestors(i)
	for (j = 1; j <= nb; j++) MANC[j] = ANC[j]
	for (j = 0; j < VN[ms]; j++) {
		x = VE[ms, j]
		where = path "." DS(x, "name")
		if (DB(x, "static") && DB(x, "const")) val_err(where ": a static method cannot be const")
		if (DB(x, "static") && DB(x, "virtual")) val_err(where ": a static method cannot be virtual")
		if ((DB(x, "pure") || DB(x, "override")) && !DB(x, "virtual"))
			val_err(where ": a " (DB(x, "pure") ? "pure" : "override") " method must be virtual")
		if (DB(x, "pure") && kind == "") val_err(where ": pure method in a concrete module (make it abstract or an interface)")
		if (kind == "interface" && !DB(x, "pure")) val_err(where ": methods of an interface module must be pure")
		inh = inherited(nb, DS(x, "name"))
		if (DB(x, "override")) {
			if (!inh) val_err(where ": overrides no virtual method of a base")
			else if (method_signature(x) != method_signature(INH_METHOD))
				val_err(where ": signature differs from " M_PATH[inh] "." DS(x, "name") " it overrides")
		}
		if (DS(x, "name") in attrs) val_err(path ": '" DS(x, "name") "' is both an attribute and a method")
		check_message(x, path "." DS(x, "name"))
		ps = DL(x, "params")
		for (c = 0; c < VN[ps]; c++) {
			p = VE[ps, c]
			if (DB(p, "const") && DH(p, "direction") && DS(p, "direction") != "in")
				val_err(path "." DS(x, "name") "(" DS(p, "name") "): an " DS(p, "direction") " parameter cannot be const")
		}
	}
	if (kind == "interface" && VN[as]) val_err(path ": an interface module cannot have attributes")
	c = split(M_BASES[i], parts, " ")
	self_ = 0
	for (j = 1; j <= c; j++) if (parts[j] == path) self_ = 1
	if (self_) val_err(path " derives from itself")
	else {
		for (j = 1; j <= c; j++) if (is_ancestor(M_IDX[parts[j]], i)) break
		if (j <= c) val_err(path " derives from itself through its bases")
	}
	for (j = 1; j <= c; j++) S[j] = parts[j]
	n = dups_of(c)
	for (j = 1; j <= n; j++) val_err(path " derives from " VDUP[j] " more than once")
	if (kind == "") {
		n = unimplemented(i)
		for (j = 1; j <= n; j++)
			val_err(path " does not implement pure method " M_PATH[UN_BASE[j]] "." UN_NAME[j] " (implement it or make the module abstract)")
	}
}

# First of the ancestors MANC[1..n] with a virtual method `name`: its index (method in INH_METHOD), else 0.
function inherited(n, name,    j, ms, k) {
	for (j = 1; j <= n; j++) {
		ms = DL(M_DEF[MANC[j]], "methods")
		for (k = 0; k < VN[ms]; k++)
			if (DS(VE[ms, k], "name") == name && DB(VE[ms, k], "virtual")) {
				INH_METHOD = VE[ms, k]
				return MANC[j]
			}
	}
	return 0
}

# --------------------------------------------------------------- links ----

# Whether module id `inner` is `outer` or inside it (own modules; an imported one only itself).
function in_subtree(outer, inner) {
	if (outer == inner) return 1
	if (index(outer, "/") || index(inner, "/")) return 0
	return index(inner, outer ".") == 1
}

# Interface name of a port of a link end ("" none).
function port_iface(id, port) { return DS(port, "interface") }

function validate_links(    links, n, j, i, l, from, to, fp, tp, fr, tr, foreign, e, nm, c, iface, ms, k, m, ps, x, bf, bt, between, transport, s, path, ack) {
	links = DL(LD_ROOT, "links")
	n = dups(links, "name")
	for (j = 1; j <= n; j++) val_err("Duplicate link name '" VDUP[j] "'")
	for (i = 1; i <= L_N; i++) {
		l = L_DEF[i]
		from = L_FROM[i]
		to = L_TO[i]
		fp = L_FROMPORT[i]
		tp = L_TOPORT[i]
		if (in_subtree(from, to)) { fr = "in"; tr = "in" }
		else if (in_subtree(to, from)) { fr = "out"; tr = "out" }
		else { fr = "out"; tr = "in" }
		if (DS(fp, "role") != fr) val_err("Link '" DS(l, "name") "': source port '" DS(fp, "name") "' must be an '" fr "' port")
		if (DS(tp, "role") != tr) val_err("Link '" DS(l, "name") "': target port '" DS(tp, "name") "' must be an '" tr "' port")
		# Imported ports use this project's interface of the same name.
		foreign = 0
		if (index(from, "/") && (nm = DS(fp, "interface")) != "" && !(nm in IFACE_IDX)) {
			val_err("Link '" DS(l, "name") "': " from ":" DS(fp, "name") " uses interface '" nm "', not defined in this project")
			foreign++
		}
		if (index(to, "/") && (nm = DS(tp, "interface")) != "" && !(nm in IFACE_IDX)) {
			val_err("Link '" DS(l, "name") "': " to ":" DS(tp, "name") " uses interface '" nm "', not defined in this project")
			foreign++
		}
		if (!foreign && DS(fp, "interface") != DS(tp, "interface"))
			val_err("Link '" DS(l, "name") "': ports use different interfaces")
		if (index(from, "/") && index(to, "/"))
			val_err("Link '" DS(l, "name") "' joins two imported modules: one end must be in this project")
		c = D(l, "constraints")
		nm = DS(fp, "interface")
		if (nm != "" && (nm in IFACE_IDX) && DS(c, "direction") == "unidirectional") {
			iface = I_DEF[IFACE_IDX[nm]]
			ms = DL(iface, "messages")
			for (k = 0; k < VN[ms]; k++) {
				m = VE[ms, k]
				ps = DL(m, "params")
				x = 0
				for (j = 0; j < VN[ps]; j++) if (DH(VE[ps, j], "direction") && DS(VE[ps, j], "direction") != "in") x = 1
				if (DH(m, "returns")) val_err("Link '" DS(l, "name") "' is unidirectional but " nm "." DS(m, "name") " returns a value")
				else if (x) val_err("Link '" DS(l, "name") "' is unidirectional but " nm "." DS(m, "name") " has out parameters")
			}
		}
		ack = D(c, "ack")
		if (DS(c, "direction") == "unidirectional" && DB(ack, "required"))
			val_err("Link '" DS(l, "name") "' is unidirectional but requires an ack")
		bf = binary_of(from)
		bt = binary_of(to)
		between = "binaries " bf " and " bt
		x = D(c, "remote")
		transport = DS(x, "transport")
		if (bf != "" && bt != "" && bf != bt && !DB(x, "enabled"))
			val_err("Link '" DS(l, "name") "' joins " between ": it must be remote")
		else if (bf != "" && bt != "" && bf != bt && transport == "")
			val_err("Link '" DS(l, "name") "' joins " between ": it needs a transport")
		s = D(x, "settings")
		if (s && VT[s] == "dict" && DB(x, "enabled")) {
			path = DS(s, "path")
			if ((transport == "http" || transport == "websocket") && path != "" && substr(path, 1, 1) != "/")
				val_err("Link '" DS(l, "name") "': path '" path "' must start with '/'")
			if (transport == "shm" && D(s, "name")) {
				nm = DS(s, "name")
				if (nm !~ /^\/?[^\/]+$/ || length(nm) > 255)
					val_err("Link '" DS(l, "name") "': shared memory name '" nm "' is not valid")
			}
		}
	}
}
