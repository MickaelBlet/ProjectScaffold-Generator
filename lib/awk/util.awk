# util.awk - helpers over the value heap of sh_jinja (value.awk): field access with defaults,
# construction, sorting, strings.

# Value of key `k` of dict `d`, 0 when absent (or `d` is not a dict).
function D(d, k) {
	if (!d || (VT[d] != "dict" && VT[d] != "ns")) return 0
	return v_dgets(d, k)
}

# Value of key `k`, `none` when absent or null.
function DN(d, k,    v) {
	v = D(d, k)
	return v ? v : V_NONE
}

# Text of key `k`: "" when absent or null.
function DS(d, k,    v) {
	v = D(d, k)
	if (!v || VT[v] == "none") return ""
	return v_tostr(v)
}

# Whether key `k` is present and not null.
function DH(d, k,    v) {
	v = D(d, k)
	return v && VT[v] != "none"
}

# List of key `k`: a new empty list when absent or null.
function DL(d, k,    v) {
	v = D(d, k)
	if (!v || VT[v] == "none") return v_list()
	return v
}

# Truth of key `k` as JavaScript's `!!`.
function DB(d, k,    v) {
	v = D(d, k)
	return v ? v_truth(v) : 0
}

# Sets key `k` of `d` to the value `v`; returns `d`.
function set(d, k, v) { return v_dsets(d, k, v) }

# String value, or `none` for "".
function str_or_none(s) { return s == "" ? V_NONE : v_str(s) }

# Text of a value: "" for none / undefined (as `?? ''`).
function txt(v) { return (!v || VT[v] == "none" || VT[v] == "undef") ? "" : v_tostr(v) }

function push(l, x) { VE[l, VN[l]++] = x; return l }

# New list holding the items of `a` then those of `b`.
function concat(a, b,    r, i) {
	r = v_list()
	for (i = 0; i < VN[a]; i++) push(r, VE[a, i])
	for (i = 0; i < VN[b]; i++) push(r, VE[b, i])
	return r
}

# Appends the items of `b` to the list `a`.
function extend(a, b,    i) {
	for (i = 0; i < VN[b]; i++) push(a, VE[b, i])
	return a
}

# List of the strings of the array `arr` (1-based, `n` items).
function strlist(arr, n,    l, i) {
	l = v_list()
	for (i = 1; i <= n; i++) push(l, v_str(arr[i]))
	return l
}

# Strings of a list joined by `sep`.
function joinl(l, sep,    s, i) {
	s = ""
	for (i = 0; i < VN[l]; i++) s = s "" (i ? sep : "") v_tostr(VE[l, i])
	return s
}

# Whether the list `l` holds the string `s`.
function lhas(l, s,    i) {
	for (i = 0; i < VN[l]; i++) if (v_tostr(VE[l, i]) == s) return 1
	return 0
}

# Sorts the list `l` in place by the strings SK[item] (byte order, stable): merge sort.
function sort_by_key(l,    n, w, i, lo, mid, hi, a, b, k, tmp) {
	n = VN[l]
	for (w = 1; w < n; w *= 2) {
		for (lo = 0; lo < n; lo += 2 * w) {
			mid = lo + w
			hi = lo + 2 * w
			if (mid > n) mid = n
			if (hi > n) hi = n
			a = lo; b = mid; k = lo
			while (a < mid && b < hi) {
				if (("" SK[VE[l, b]]) < ("" SK[VE[l, a]])) tmp[k++] = VE[l, b++]
				else tmp[k++] = VE[l, a++]
			}
			while (a < mid) tmp[k++] = VE[l, a++]
			while (b < hi) tmp[k++] = VE[l, b++]
			for (i = lo; i < hi; i++) VE[l, i] = tmp[i]
		}
	}
	return l
}

# Sorts a list of strings in place (byte order).
function sort_strings(l,    i) {
	for (i = 0; i < VN[l]; i++) SK[VE[l, i]] = v_tostr(VE[l, i])
	return sort_by_key(l)
}

# JavaScript numbers: integral floats are ints (YAML / JSON `1.0` is 1).
function jsnum(v,    i, n, k, x) {
	if (VT[v] == "float") {
		x = VV[v] + 0
		if (x == int(x) && x < 9e15 && x > -9e15) {
			VT[v] = "int"
			VV[v] = v_ifmt(x)
		}
	} else if (VT[v] == "list") {
		n = VN[v]
		for (i = 0; i < n; i++) jsnum(VE[v, i])
	} else if (VT[v] == "dict") {
		n = VN[v]
		for (i = 0; i < n; i++) {
			k = VK[v, i]
			jsnum(VD[v, v_hk(k)])
		}
	}
	return v
}

# Whole content of a file; FILE_OK is 0 when it cannot be read.
function read_file(path,    s) {
	s = io_read(path)
	FILE_OK = IO_OK
	return s
}

# Shell word quoting a string.
function shq(s) {
	gsub(/'/, "'\\''", s)
	return "'" s "'"
}

# s with its leading / trailing spaces removed (JavaScript trim: whitespace).
function trim(s) {
	sub(/^[ \t\n\r\f\v]+/, "", s)
	sub(/[ \t\n\r\f\v]+$/, "", s)
	return s
}

function rtrim(s) {
	sub(/[ \t\n\r\f\v]+$/, "", s)
	return s
}
