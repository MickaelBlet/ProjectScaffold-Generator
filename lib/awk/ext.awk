# ext.awk - template filters of the generator (sh_jinja extension points, see
# sh_jinja/lib/awk/ext.awk): case conversions, uuid, doc_comment, user.

function x_init() {
	X_FILTER["snake"] = 1
	X_FILTER["kebab"] = 1
	X_FILTER["constant"] = 1
	X_FILTER["pascal"] = 1
	X_FILTER["camel"] = 1
	X_FILTER["ucfirst"] = 1
	X_FILTER["lcfirst"] = 1
}

function x_filter(name, v, p,    s) {
	s = txt(v)
	if (name == "snake") return v_str(snake(s))
	if (name == "kebab") return v_str(kebab(s))
	if (name == "constant") return v_str(constant(s))
	if (name == "pascal") return v_str(pascal(s))
	if (name == "camel") return v_str(camel(s))
	if (name == "ucfirst") return v_str(ucfirst(s))
	if (name == "lcfirst") return v_str(lcfirst(s))
}

function x_test(name, v, p) { return 0 }

function x_error(cls, msg, tname, line) { return x_error_cli(cls, msg, tname, line) }
