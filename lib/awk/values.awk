# values.awk - default values and constants checked against their type (src/model/defaults.ts):
#   value_errors(v, t) -> number of problems, in VE_MSG[1..n]; t: a type reference of the file.
# Integers are compared as decimal text: 64-bit ranges are exact.

# --------------------------------------------------------- big integers ----

# Decimal text without sign: leading zeros removed.
function bi_abs(s) {
	sub(/^[-+]/, "", s)
	sub(/^0+/, "", s)
	return s == "" ? "0" : s
}

function bi_neg(s) { return substr(s, 1, 1) == "-" && bi_abs(s) != "0" }

# Signed decimal text normalized: "-12", "0", "7".
function bi_norm(s) { return (bi_neg(s) ? "-" : "") bi_abs(s) }

# Compares two non-negative decimal texts: -1, 0, 1.
function bi_ucmp(a, b) {
	if (length(a) != length(b)) return length(a) < length(b) ? -1 : 1
	if (a == b) return 0
	return a < b ? -1 : 1
}

function bi_cmp(a, b,    na, nb, c) {
	a = bi_norm(a)
	b = bi_norm(b)
	na = substr(a, 1, 1) == "-"
	nb = substr(b, 1, 1) == "-"
	if (na != nb) return na ? -1 : 1
	c = bi_ucmp(bi_abs(a), bi_abs(b))
	return na ? -c : c
}

# Decimal text of the hexadecimal digits h.
function bi_hex(h,    s, i, d, j, carry, x, r) {
	s = "0"
	h = tolower(h)
	for (i = 1; i <= length(h); i++) {
		d = index("0123456789abcdef", substr(h, i, 1)) - 1
		# s = s * 16 + d
		r = ""
		carry = d
		for (j = length(s); j >= 1; j--) {
			x = substr(s, j, 1) * 16 + carry
			carry = int(x / 10)
			r = (x % 10) r
		}
		while (carry) {
			r = (carry % 10) r
			carry = int(carry / 10)
		}
		s = r
	}
	return bi_abs(s)
}

# Range of an integer primitive: VR_MIN / VR_MAX (decimal text); 0 when not one.
function int_range(name) {
	if (name == "int8") { VR_MIN = "-128"; VR_MAX = "127" }
	else if (name == "int16") { VR_MIN = "-32768"; VR_MAX = "32767" }
	else if (name == "int32") { VR_MIN = "-2147483648"; VR_MAX = "2147483647" }
	else if (name == "int64") { VR_MIN = "-9223372036854775808"; VR_MAX = "9223372036854775807" }
	else if (name == "uint8") { VR_MIN = "0"; VR_MAX = "255" }
	else if (name == "uint16") { VR_MIN = "0"; VR_MAX = "65535" }
	else if (name == "uint32") { VR_MIN = "0"; VR_MAX = "4294967295" }
	else if (name == "uint64") { VR_MIN = "0"; VR_MAX = "18446744073709551615" }
	else return 0
	return 1
}

function is_int_primitive(name) { return name ~ /^u?int(8|16|32|64)$/ }

# Integer of a value as decimal text (numbers, and text in decimal or 0x hexadecimal); "" when not one.
function to_bigint(v,    t, s, neg, x) {
	t = VT[v]
	if (t == "int") return bi_norm(VV[v])
	if (t == "float") {
		x = VV[v] + 0
		if (x != int(x) || x != x) return ""
		return bi_norm(sprintf("%.0f", x))
	}
	if (t != "str") return ""
	s = VV[v]
	if (s !~ /^[-+]?(0[xX][0-9a-fA-F]+|[0-9]+)$/) return ""
	neg = substr(s, 1, 1) == "-"
	sub(/^[-+]/, "", s)
	s = s ~ /^0[xX]/ ? bi_hex(substr(s, 3)) : bi_abs(s)
	return (neg && s != "0" ? "-" : "") s
}

# ------------------------------------------------------- values as text ----

# JavaScript String() of a scalar.
function js_str(v,    t) {
	t = VT[v]
	if (t == "bool") return VV[v] ? "true" : "false"
	if (t == "none") return "null"
	if (t == "float") return js_num(VV[v] + 0)
	return v_tostr(v)
}

function js_num(x,    s) {
	if (x == int(x) && x < 1e21 && x > -1e21) return sprintf("%.0f", x)
	s = v_fltrepr(x)
	# Python 1e-07 -> JavaScript 1e-7
	if (s ~ /e[-+]0[0-9]$/) sub(/e-0/, "e-", s)
	if (s ~ /e[-+]0[0-9]$/) sub(/e\+0/, "e+", s)
	return s
}

BEGIN { YAML_INDICATORS = "-?:,[]{}#&*!|>'\"%@`" }

# A string as YAML writes it in flow style: plain when it reads back as the same string.
function yaml_scalar_str(s) {
	if (s == "" || (index(YAML_INDICATORS, substr(s, 1, 1)) && !(index("-?:", substr(s, 1, 1)) && !index(" \t,[]{}", substr(s, 2, 1)))) || yaml_has_flow(s) || s ~ /: |:$| #/ || s ~ /^[ \t]|[ \t]$/ || s ~ /[\n\r\t]/ || VT[yaml_resolve_core(s)] != "str")
		return "\"" yaml_dq_escape(s) "\""
	return s
}

# characters starting a YAML indicator, not a plain scalar
function yaml_has_flow(s) { return index(s, ",") || index(s, "[") || index(s, "]") || index(s, "{") || index(s, "}") }

function yaml_dq_escape(s) {
	gsub(/\\/, "\\\\", s)
	gsub(/"/, "\\\"", s)
	gsub(/\n/, "\\n", s)
	gsub(/\t/, "\\t", s)
	gsub(/\r/, "\\r", s)
	return s
}

# Value written as a one-line YAML flow literal: `{ x: 1, y: [ 2, 3 ] }`.
function format_value(v,    t, s, i, k) {
	t = VT[v]
	if (t == "none") return "null"
	if (t == "bool") return VV[v] ? "true" : "false"
	if (t == "int") return VV[v]
	if (t == "float") return js_num(VV[v] + 0)
	if (t == "str") return yaml_scalar_str(VV[v])
	if (t == "list") {
		if (!VN[v]) return "[]"
		s = "[ "
		for (i = 0; i < VN[v]; i++) s = s "" (i ? ", " : "") format_value(VE[v, i])
		return s " ]"
	}
	if (t == "dict") {
		if (!VN[v]) return "{}"
		s = "{ "
		for (i = 0; i < VN[v]; i++) {
			k = VK[v, i]
			s = s "" (i ? ", " : "") yaml_scalar_str(js_str(k)) ": " format_value(VD[v, v_hk(k)])
		}
		return s " }"
	}
	return v_tostr(v)
}

function describe(v,    t) {
	t = VT[v]
	if (t == "none") return "null"
	if (t == "list") return "a list"
	if (t == "dict") return "a mapping"
	return (t == "str" ? "text" : t == "bool" ? "boolean" : "number") " " format_value(v)
}

# --------------------------------------------------------------- types ----

# Follows aliases from a type reference: VRS_KIND ("" for a deleted type or a cyclic alias),
# VRS_REF (the reference, when not a user type) or VRS_DEF (the type definition).
function vresolve(t,    k, key, def, seen, n) {
	n = 0
	while (1) {
		k = DS(t, "kind")
		if (k != "ref") { VRS_KIND = k; VRS_REF = t; VRS_DEF = 0; return k }
		key = DS(t, "name")
		if (!(key in TYPE_IDX) || (key in seen)) { VRS_KIND = ""; VRS_DEF = 0; return "" }
		def = T_DEF[TYPE_IDX[key]]
		if (DS(def, "kind") != "alias") { VRS_KIND = "def"; VRS_DEF = def; VRS_REF = 0; return "def" }
		seen[key] = 1
		t = D(def, "type")
	}
}

# Whether a struct field of type `t` may be left out of a value: optional, or a struct whose
# fields may all be left out.
function implicit(t, seen,    def, fs, i, f, key) {
	vresolve(t)
	if (VRS_KIND == "optional") return 1
	if (VRS_KIND != "def" || DS(VRS_DEF, "kind") != "struct") return 0
	def = VRS_DEF
	key = def
	if (key in seen) return 0
	seen[key] = 1
	fs = DL(def, "fields")
	for (i = 0; i < VN[fs]; i++) {
		f = VE[fs, i]
		if (!D(f, "default") && !implicit(D(f, "type"), seen)) return 0
	}
	return 1
}

# -------------------------------------------------------------- checks ----

function ve_at(path, msg) {
	VE_N++
	VE_MSG[VE_N] = path != "" ? path ": " msg : msg
}

function value_errors(v, t,    seen) {
	VE_N = 0
	ve_check(v, t, "", seen)
	return VE_N
}

function primitive_error(v, name,    t, n) {
	t = VT[v]
	if (name == "bool") return t == "bool" ? "" : "Expected true or false, got " describe(v)
	if (name == "float32" || name == "float64")
		return (t == "int" || t == "float") && m_special(VV[v] + 0) == "" ? "" : "Expected a number, got " describe(v)
	if (name == "char") return t == "str" && u8_len(VV[v]) == 1 ? "" : "Expected one character, got " describe(v)
	if (name == "string" || name == "bytes") {
		if (t == "str") return ""
		return t != "none" && t != "list" && t != "dict" ? "Expected text, got " describe(v) " (quote it: \"" js_str(v) "\")" : "Expected text, got " describe(v)
	}
	n = to_bigint(v)
	if (n == "" || VT[v] == "bool") return "Expected an integer, got " describe(v)
	int_range(name)
	return bi_cmp(n, VR_MIN) < 0 || bi_cmp(n, VR_MAX) > 0 ? n " does not fit in " name : ""
}

# Map keys are text: read them as the key type.
function ve_key(k, t,    s) {
	s = js_str(k)
	vresolve(t)
	if (VRS_KIND != "primitive") return v_str(s)
	if (DS(VRS_REF, "name") == "bool") return s == "true" ? V_TRUE : s == "false" ? V_FALSE : v_str(s)
	if ((DS(VRS_REF, "name") == "float32" || DS(VRS_REF, "name") == "float64") && s ~ /^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$/) return v_float(s + 0)
	return v_str(s)
}

function ve_check(v, t, path, seen,    k, e, size, n, i, texts, j, key, def, dk, names, x, c, cases, fs, f, name, seen2) {
	k = DS(t, "kind")
	if (k == "primitive") {
		e = primitive_error(v, DS(t, "name"))
		if (e != "") ve_at(path, e)
		else if (DH(t, "max") && VT[v] == "str") {
			size = DS(t, "name") == "bytes" ? u8_len(VV[v]) : length(VV[v])
			if (size > DS(t, "max") + 0) ve_at(path, size " bytes, more than the bound of " DS(t, "max"))
		}
		return
	}
	if (k == "optional") {
		if (VT[v] != "none") ve_check(v, D(t, "of"), path, seen)
		return
	}
	if (k == "array" || k == "vector" || k == "list" || k == "set") {
		if (VT[v] != "list") return ve_at(path, "Expected a list, got " describe(v))
		n = VN[v]
		if (k == "array" && n != DS(t, "size") + 0) ve_at(path, "Expected " DS(t, "size") " elements, got " n)
		if (k != "array" && DH(t, "max") && n > DS(t, "max") + 0) ve_at(path, n " elements, more than the bound of " DS(t, "max"))
		for (i = 0; i < n; i++) ve_check(VE[v, i], D(t, "of"), path "[" i "]", seen)
		if (k == "set") {
			for (i = 0; i < n; i++) {
				texts[i] = format_value(VE[v, i])
				for (j = 0; j < i; j++) if (texts[j] == texts[i]) break
				if (j < i) ve_at(path, "Duplicate element " texts[i])
			}
		}
		return
	}
	if (k == "map") {
		if (VT[v] != "dict") return ve_at(path, "Expected a mapping, got " describe(v))
		if (DH(t, "max") && VN[v] > DS(t, "max") + 0) ve_at(path, VN[v] " entries, more than the bound of " DS(t, "max"))
		for (i = 0; i < VN[v]; i++) {
			key = VK[v, i]
			ve_check(ve_key(key, D(t, "key")), D(t, "key"), path "[" js_str(key) "]", seen)
			ve_check(VD[v, v_hk(key)], D(t, "value"), path "[" js_str(key) "]", seen)
		}
		return
	}
	if (k != "ref") return
	name = DS(t, "name")
	# Deleted types are reported on their own.
	if (!(name in TYPE_IDX)) return
	def = T_DEF[TYPE_IDX[name]]
	dk = DS(def, "kind")
	if (dk == "primitive") return
	if (dk == "alias") {
		if (!((name) in seen)) {
			for (x in seen) seen2[x] = 1
			seen2[name] = 1
			ve_check(v, D(def, "type"), path, seen2)
		}
		return
	}
	if (dk == "enum") {
		x = DL(def, "values")
		names = ""
		c = 0
		for (i = 0; i < VN[x]; i++) {
			names = names "" (i ? ", " : "") DS(VE[x, i], "name")
			if (VT[v] == "str" && DS(VE[x, i], "name") == VV[v]) c = 1
		}
		if (!c) ve_at(path, "Expected a value of " DS(def, "name") " (" names "), got " describe(v))
		return
	}
	if (dk == "bitmask") {
		x = DL(def, "flags")
		names = ""
		for (i = 0; i < VN[x]; i++) names = names "" (i ? ", " : "") DS(VE[x, i], "name")
		if (VT[v] != "list") return ve_at(path, "Expected a list of " DS(def, "name") " flags, got " describe(v))
		for (i = 0; i < VN[v]; i++) {
			e = VE[v, i]
			if (VT[e] != "str" || !index(", " names ", ", ", " VV[e] ", ")) ve_at(path "[" i "]", "Expected a flag of " DS(def, "name") " (" names "), got " describe(e))
			else {
				for (j = 0; j < i; j++) if (VT[VE[v, j]] == "str" && VV[VE[v, j]] == VV[e]) break
				if (j < i) ve_at(path, "Duplicate flag " VV[e])
			}
		}
		return
	}
	if (dk == "union") {
		if (VT[v] != "dict" || VN[v] != 1)
			return ve_at(path, "Expected a mapping of one " DS(def, "name") " case (case: value), got " describe(v))
		key = js_str(VK[v, 0])
		cases = DL(def, "cases")
		for (i = 0; i < VN[cases]; i++) if (DS(VE[cases, i], "name") == key) break
		if (i == VN[cases]) return ve_at(path, "Unknown case '" key "' of " DS(def, "name"))
		ve_check(VD[v, v_hk(VK[v, 0])], D(VE[cases, i], "type"), path != "" ? path "." key : key, seen)
		return
	}
	# struct / exception
	if (VT[v] != "dict") return ve_at(path, "Expected a mapping of " DS(def, "name") " fields, got " describe(v))
	fs = DL(def, "fields")
	for (i = 0; i < VN[v]; i++) {
		key = js_str(VK[v, i])
		for (j = 0; j < VN[fs]; j++) if (DS(VE[fs, j], "name") == key) break
		if (j == VN[fs]) ve_at(path, "Unknown field '" key "' of " DS(def, "name"))
	}
	for (j = 0; j < VN[fs]; j++) {
		f = VE[fs, j]
		e = v_dgets(v, DS(f, "name"))
		if (e) ve_check(e, D(f, "type"), path != "" ? path "." DS(f, "name") : DS(f, "name"), seen)
		else if (!D(f, "default") && !implicit(D(f, "type")))
			ve_at(path, "Missing field '" DS(f, "name") "' of " DS(def, "name"))
	}
}
