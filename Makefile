all: build

deps: clean
	npm install

test: deps
	npm run test
	
build: test
	npm run build
	@echo "Build success!"
	# cp dist/orbit-db-store.min.js dist/orbit-db-keystore.min.js.map examples/browser
	@echo "Built: 'dist/', 'examples/browser/'"

clean:
	rm -rf ipfs/
	rm -rf keystore/

clean-dependencies: clean
	rm -f package-lock.json
	rm -rf node_modules/

rebuild: | clean-dependencies build
	
.PHONY: test
