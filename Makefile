.PHONY: start dev new-card

start:
	@node server.js

dev:
	@npx -y nodemon --watch server.js server.js

new-card:
	@node cli/new-card.js title="$(title)" type="$(type)"
