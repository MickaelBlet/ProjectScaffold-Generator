# Interop check of the calls between binaries (scripts/check_remote.sh): interop.cpp (interop98.cpp for
# the cpp98 templates) over the code generated from tests/fixtures/relay.scaffold.yaml.
cmake_minimum_required(VERSION 3.16)
project(relay_interop LANGUAGES CXX)

set(RELAY_DIR "" CACHE PATH "code generated from tests/fixtures/relay.scaffold.yaml")
add_subdirectory(${RELAY_DIR} relay)

if(CMAKE_CXX_STANDARD EQUAL 98)
    add_executable(interop interop98.cpp)
else()
    add_executable(interop interop.cpp)
endif()
target_link_libraries(interop PRIVATE relay)
