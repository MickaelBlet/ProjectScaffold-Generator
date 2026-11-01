# main.awk - entry point (run by bin/scaffold-gen; options as awk variables, see cli.awk).
BEGIN {
	jinja_init()
	YAML_CORE = 1
	exit cli_main()
}
