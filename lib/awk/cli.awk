# cli.awk - one project's run, driven by bin/scaffold-gen. Variables (-v):
#   MODE    `dump-context`: print the generation context as JSON; else generate
#   FILE    project file
#   LABEL   project file as messages name it (relative to the working directory)
#   SCHEMA  schema/scaffold.schema.json

# Prints an error of the project file.
function cli_error(msg) {
	printf "%s: error: %s\n", LABEL, msg > "/dev/stderr"
	close("/dev/stderr")
}

function x_error_cli(cls, msg, tname, line) {
	if (LD_PARSING) return LABEL ": error: " (line ? "Line " line ": " : "") "Invalid " toupper(LD_FORMAT) ": " msg
	return LABEL ": error: " tname ":" line ": " msg
}

function cli_main(    file, ctx, schema, n, s, i) {
	schema = json_parse(read_file(SCHEMA), SCHEMA)
	file = load_project(FILE, schema)
	n = validate()
	if (n) {
		s = "the project has " n " error" (n > 1 ? "s" : "") ":"
		for (i = 1; i <= n; i++) s = s "\n  " VAL_MSG[i]
		cli_error(s)
		return 1
	}
	ctx = ctx_build(file)
	if (MODE == "dump-context") {
		printf "%s\n", cli_json(ctx)
		return 0
	}
	return 0
}

# JSON of a value for --dump-context (compact); a value inside itself as "<cycle>".
function cli_json(v,    t, s, i, k) {
	t = VT[v]
	if (t == "list" || t == "tuple" || t == "dict") {
		if (v in CLI_STACK) return "\"<cycle>\""
		CLI_STACK[v] = 1
		if (t == "dict") {
			s = "{"
			for (i = 0; i < VN[v]; i++) {
				k = VK[v, i]
				s = s "" (i ? "," : "") json_key(k) ":" cli_json(VD[v, v_hk(k)])
			}
			s = s "}"
		} else {
			s = "["
			for (i = 0; i < VN[v]; i++) s = s "" (i ? "," : "") cli_json(VE[v, i])
			s = s "]"
		}
		delete CLI_STACK[v]
		return s
	}
	return json_dump1(v, "", "", 0)
}
