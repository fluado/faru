.PHONY: start dev new-card publish

start:
	@node server.js

dev:
	@npx -y nodemon --watch server.js server.js

new-card:
	@node cli/new-card.js title="$(title)" type="$(type)"

publish:
	cd .. && git subtree push --prefix=board git@github.com:fluado/faru.git main
