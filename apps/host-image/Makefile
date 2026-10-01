# make image VERSION=1.0.0 [BUILD_FLAGS=--without-bootstrap]
# make verify VERSION=1.0.0
VERSION ?=
BUILD_FLAGS ?=

.PHONY: image verify clean

image:
	@test -n "$(VERSION)" || { echo "usage: make image VERSION=<image-version>" >&2; exit 2; }
	./build.sh --version $(VERSION) $(BUILD_FLAGS)

verify:
	@test -n "$(VERSION)" || { echo "usage: make verify VERSION=<image-version>" >&2; exit 2; }
	./verify.sh out/$(VERSION)/devchain-host-$(VERSION).qcow2

clean:
	rm -rf out
