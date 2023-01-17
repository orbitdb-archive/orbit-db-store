all: build

deps: clean
	npm install

test: deps
	npm run test
	
build: test
	npm run build
	@echo "Build success!"
	@echo "Built: 'dist/', 'examples/browser/'"

clean:
	rm -rf ipfs/
	rm -rf orbitdb/
	rm -rf keystore/
	rm -rf cache/
	rm -rf identity/
	rm -rf node_modules/
	rm -rf test/data/
	rm -f dist/orbit-db-store.min.js.map

clean-dependencies: clean
	rm -f package-lock.json

rebuild: | clean-dependencies build
	
.PHONY: test
