.PHONY: start dev publish

start:
	@node server.js

dev:
	@npx -y nodemon --watch server.js server.js

publish:
	cd .. && git subtree push --prefix=board git@github.com:fluado/faru.git main
