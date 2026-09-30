# Interop check of the calls between binaries (scripts/check_remote.sh): interop.cpp over the code
# generated from tests/fixtures/relay.scaffold.yaml.
cmake_minimum_required(VERSION 3.16)
project(relay_interop LANGUAGES CXX)

set(RELAY_DIR "" CACHE PATH "code generated from tests/fixtures/relay.scaffold.yaml")
add_subdirectory(${RELAY_DIR} relay)

add_executable(interop interop.cpp)
target_link_libraries(interop PRIVATE relay)
