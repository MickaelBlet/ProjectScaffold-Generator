# schema.awk - structure check of a project file against the published JSON Schema
# (schema/scaffold.schema.json), with the messages of zod (the editor's model, which generates the
# schema): the same errors as the editor for the same file.
#
#   sc_init(schema)          the schema, as parsed
#   sc_check_file(v, root_line)
#                            issues in SC_MSG[1..SC_N] ("path: message") and SC_LINE[i] (0: none)
#
# Only the keywords the schema uses: type, properties, required, items, $ref, enum, const,
# pattern, minLength, minimum, maximum, exclusiveMinimum, propertyNames / additionalProperties
# (records), anyOf (unions; `[X, null]`: nullable X), oneOf (unions discriminated by `kind`).
# As zod: unknown properties are allowed; a type error stops the checks of a value (it "aborts"),
# the other checks (length, bounds, patterns) do not; a union reports the issues of its only
# option without aborting ones, else "Invalid input".

function sc_init(schema) {
	SC_SCHEMA = schema
	SC_DEFS = D(schema, "$defs")
}

function sc_resolve(s,    r) {
	while (s && (r = D(s, "$ref"))) {
		r = v_tostr(r)
		sub(/^#\/\$defs\//, "", r)
		s = D(SC_DEFS, r)
	}
	return s
}

# zod's name of the type of a value
function sc_received(v,    t) {
	if (!v) return "undefined"
	t = VT[v]
	if (t == "none") return "null"
	if (t == "list") return "array"
	if (t == "dict") return "object"
	if (t == "int" || t == "float") return "number"
	if (t == "str") return "string"
	if (t == "bool") return "boolean"
	return t
}

function sc_issue(path, msg, line, aborting) {
	SC_N++
	SC_MSG[SC_N] = (path == "" ? "<root>" : path) ": " msg
	SC_LINE[SC_N] = line
	SC_ABORT[SC_N] = aborting
}

function sc_check_file(v, root_line) {
	SC_N = 0
	sc_check(v, SC_SCHEMA, "", root_line)
}

function sc_join(path, key) { return path == "" ? key : path "." key }

# Line of entry `key` (string) of dict `d`, else `dflt`.
function sc_kline(d, key, dflt,    hk) {
	hk = "s" key
	return ((d, hk) in YKLINE) ? YKLINE[d, hk] : dflt
}

function sc_iline(l, i, dflt) { return ((l, i) in YILINE) ? YILINE[l, i] : dflt }

# Checks value `v` (0: absent) against schema `s` at `path` (line `ln`).
function sc_check(v, s, path, ln,    t, ty, r, i, n, props, req, k, key, x, alt, opts, m, start, ok, nonab, which, kind, expd, keys) {
	s = sc_resolve(s)
	if (D(s, "anyOf")) return sc_any(v, s, path, ln)
	if (D(s, "oneOf")) return sc_one(v, s, path, ln)
	ty = DS(s, "type")
	if (D(s, "const")) {
		x = D(s, "const")
		if (!v || v_hk(v) != v_hk(x) || VT[v] != VT[x]) {
			sc_issue(path, "Invalid input: expected " (VT[x] == "str" ? "\"" v_tostr(x) "\"" : v_tostr(x)), ln, 1)
			return
		}
		return
	}
	if (D(s, "enum")) {
		x = D(s, "enum")
		if (v && VT[v] == "str" && lhas(x, VV[v])) return
		expd = ""
		for (i = 0; i < VN[x]; i++) expd = expd "" (i ? "|" : "") "\"" v_tostr(VE[x, i]) "\""
		sc_issue(path, "Invalid option: expected one of " expd, ln, 1)
		return
	}
	if (ty == "") return
	t = v ? VT[v] : ""
	if (ty == "string") {
		if (t != "str") return sc_type(path, "string", v, ln)
		if (D(s, "minLength") && u8_len(VV[v]) < DS(s, "minLength") + 0)
			sc_issue(path, "Too small: expected string to have >=" DS(s, "minLength") " characters", ln, 0)
		if (D(s, "pattern") && !sc_match(VV[v], DS(s, "pattern")))
			sc_issue(path, sc_pattern_message(DS(s, "pattern"), path), ln, 0)
		return
	}
	if (ty == "number" || ty == "integer") {
		if (t != "int" && t != "float") return sc_type(path, "number", v, ln)
		if (ty == "integer" && t == "float") return sc_issue(path, "Invalid input: expected int, received number", ln, 1)
		x = VV[v] + 0
		if (D(s, "exclusiveMinimum") && !(x > DS(s, "exclusiveMinimum") + 0))
			sc_issue(path, "Too small: expected number to be >" DS(s, "exclusiveMinimum"), ln, 0)
		else if (D(s, "minimum") && x < DS(s, "minimum") + 0 && DS(s, "minimum") + 0 > -9e15)
			sc_issue(path, "Too small: expected number to be >=" DS(s, "minimum"), ln, 0)
		if (D(s, "maximum") && x > DS(s, "maximum") + 0 && DS(s, "maximum") + 0 < 9e15)
			sc_issue(path, "Too big: expected number to be <=" DS(s, "maximum"), ln, 0)
		return
	}
	if (ty == "boolean") {
		if (t != "bool") return sc_type(path, "boolean", v, ln)
		return
	}
	if (ty == "null") {
		if (t != "none") return sc_type(path, "null", v, ln)
		return
	}
	if (ty == "array") {
		if (t != "list") return sc_type(path, "array", v, ln)
		x = D(s, "items")
		if (x) for (i = 0; i < VN[v]; i++) sc_check(VE[v, i], x, sc_join(path, i), sc_iline(v, i, ln))
		return
	}
	if (ty == "object") {
		props = D(s, "properties")
		if (!props) {
			# a record: keys checked by propertyNames, values by additionalProperties
			if (t != "dict") return sc_type(path, "record", v, ln)
			for (i = 0; i < VN[v]; i++) {
				k = VK[v, i]
				key = v_tostr(k)
				x = D(s, "propertyNames")
				m = SC_N
				if (x) sc_check(k, x, sc_join(path, key), sc_kline(v, key, ln))
				if (SC_N > m) {
					SC_N = m
					sc_issue(sc_join(path, key), "Invalid key in record", sc_kline(v, key, ln), 1)
					continue
				}
				x = D(s, "additionalProperties")
				if (x && VT[x] == "dict") sc_check(VD[v, v_hk(k)], x, sc_join(path, key), sc_kline(v, key, ln))
			}
			return
		}
		if (t != "dict") return sc_type(path, "object", v, ln)
		req = D(s, "required")
		for (i = 0; i < VN[props]; i++) {
			k = VK[props, i]
			key = v_tostr(k)
			x = v_dgets(v, key)
			if (!x && !(req && lhas(req, key))) continue
			sc_check(x, VD[props, v_hk(k)], sc_join(path, key), x ? sc_kline(v, key, ln) : ln)
		}
		return
	}
}

function sc_type(path, expected, v, ln) {
	sc_issue(path, "Invalid input: expected " expected ", received " sc_received(v), ln, 1)
}

# anyOf: `[X, {type: null}]` is a nullable X; else a union.
function sc_any(v, s, path, ln,    opts, n, i, m, start, nonab, which, ok, last) {
	opts = D(s, "anyOf")
	n = VN[opts]
	if (n == 2 && DS(VE[opts, 1], "type") == "null" && !D(VE[opts, 1], "anyOf")) {
		if (v && VT[v] == "none") return
		return sc_check(v, VE[opts, 0], path, ln)
	}
	# z.json(): any value
	if (sc_is_json(opts)) return
	start = SC_N
	nonab = 0
	for (i = 0; i < n; i++) {
		m = SC_N
		sc_check(v, VE[opts, i], path, ln)
		if (SC_N == m) { SC_N = start; return }
		ok = 1
		for (last = m + 1; last <= SC_N; last++) if (SC_ABORT[last]) ok = 0
		if (ok) { nonab++; which = i }
		SC_N = m
		# keep nothing of the trial
	}
	SC_N = start
	if (nonab == 1) return sc_check(v, VE[opts, which], path, ln)
	sc_issue(path, "Invalid input", ln, 1)
}

function sc_is_json(opts,    i, ty) {
	for (i = 0; i < VN[opts]; i++) {
		ty = DS(VE[opts, i], "type")
		if (ty == "null") return 1
	}
	return 0
}

# oneOf: union discriminated by `kind` (the const of each option's `kind` property).
function sc_one(v, s, path, ln,    opts, i, kind, x, expd, c) {
	opts = D(s, "oneOf")
	if (!v || VT[v] != "dict") return sc_type(path, "object", v, ln)
	x = v_dgets(v, "kind")
	kind = x && VT[x] == "str" ? VV[x] : "\001"
	expd = ""
	for (i = 0; i < VN[opts]; i++) {
		c = DS(D(D(VE[opts, i], "properties"), "kind"), "const")
		if (c == kind) return sc_check(v, VE[opts, i], path, ln)
		expd = expd "" (i ? " | " : "") "'" c "'"
	}
	sc_issue(sc_join(path, "kind"), "Invalid discriminator value. Expected " expd, x ? sc_kline(v, "kind", ln) : ln, 1)
}

function sc_match(s, pattern) {
	if (!(pattern in SC_RE)) {
		SC_RE[pattern] = pattern
		gsub(/\\\//, "/", SC_RE[pattern])
	}
	return s ~ SC_RE[pattern]
}

# zod's custom message of the pattern (the schema has none)
function sc_pattern_message(pattern, path) {
	if (pattern == "^[A-Za-z_][A-Za-z0-9_]*$") return "must be a valid identifier"
	if (pattern ~ /^\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\(/) return "must be a dot-separated module path"
	if (path ~ /^editor\./)
		return "must be a dot-separated module path, with its dependency name and a slash for a module of a dependency"
	return "must be a type name, with its module path for a type of a module (and its dependency name and a slash for a module of a dependency)"
}
