# case.awk - identifier case conversions (ASCII): `rateHz` -> rate_hz, RateHz, rateHz, RATE_HZ...

# Words of an identifier into W[1..n]; returns n. `rateHz` -> rate, Hz; `HTTPServer` -> HTTP,
# Server; `snake_case` -> snake, case. Splits before an upper case letter following a lower case
# one or a digit, and before the last of a run of upper case letters followed by a lower case one.
function words(s,    n, i, c, d, out, j, k) {
	# ([a-z0-9])([A-Z]) -> "$1 $2"
	out = ""
	n = length(s)
	for (i = 1; i <= n; i++) {
		c = substr(s, i, 1)
		d = substr(s, i + 1, 1)
		if (c ~ /[a-z0-9]/ && d ~ /[A-Z]/) {
			out = out c " " d
			i++
		} else out = out c
	}
	# ([A-Z]+)([A-Z][a-z]) -> "$1 $2"
	s = out
	out = ""
	n = length(s)
	for (i = 1; i <= n; i++) {
		c = substr(s, i, 1)
		if (c !~ /[A-Z]/) { out = out c; continue }
		for (j = i; j <= n && substr(s, j, 1) ~ /[A-Z]/; j++) ;
		# run i..j-1 of upper case letters
		if (j - i >= 2 && substr(s, j, 1) ~ /[a-z]/) {
			out = out substr(s, i, j - 1 - i) " " substr(s, j - 1, 2)
			i = j
		} else {
			out = out substr(s, i, j - i)
			i = j - 1
		}
	}
	# [A-Za-z0-9]+
	k = 0
	delete W
	while (match(out, /[A-Za-z0-9]+/)) {
		W[++k] = substr(out, RSTART, RLENGTH)
		out = substr(out, RSTART + RLENGTH)
	}
	return k
}

function c_join(n, sep, how,    i, s, w) {
	s = ""
	for (i = 1; i <= n; i++) {
		w = W[i]
		if (how == "lower") w = tolower(w)
		else if (how == "upper") w = toupper(w)
		else w = toupper(substr(w, 1, 1)) tolower(substr(w, 2))
		s = s "" (i > 1 ? sep : "") w
	}
	return s
}

function snake(s) { return c_join(words(s), "_", "lower") }
function kebab(s) { return c_join(words(s), "-", "lower") }
function constant(s) { return c_join(words(s), "_", "upper") }
function pascal(s) { return c_join(words(s), "", "cap") }
function camel(s,    p) {
	p = pascal(s)
	return tolower(substr(p, 1, 1)) substr(p, 2)
}
function ucfirst(s) { return toupper(substr(s, 1, 1)) substr(s, 2) }
function lcfirst(s) { return tolower(substr(s, 1, 1)) substr(s, 2) }

# Identifier made from a project name, as dependencies name the project (dependencies.ts).
function dependency_name(name,    id) {
	id = name
	gsub(/[^A-Za-z0-9_]+/, "_", id)
	sub(/^_+/, "", id)
	sub(/_+$/, "", id)
	if (id == "") return "Other"
	return id ~ /^[A-Za-z_][A-Za-z0-9_]*$/ ? id : "_" id
}
