cmake_minimum_required(VERSION 3.22.1)

project(bridge-native-vnc C CXX)

# AVNC's LibVNCClient is used as the native TCP/RFB implementation. Keep the
# server/examples/websocket sides out of the Android binary: this client talks
# directly to the Mac Screen Sharing TCP port.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LIBVNCSERVER_INSTALL OFF CACHE BOOL "" FORCE)
set(WITH_LIBVNCSERVER OFF CACHE BOOL "" FORCE)
set(WITH_LIBVNCCLIENT ON CACHE BOOL "" FORCE)
set(WITH_ZLIB ON CACHE BOOL "" FORCE)
set(WITH_JPEG OFF CACHE BOOL "" FORCE)
set(WITH_PNG OFF CACHE BOOL "" FORCE)
set(WITH_LZO OFF CACHE BOOL "" FORCE)
set(WITH_GNUTLS OFF CACHE BOOL "" FORCE)
set(WITH_OPENSSL OFF CACHE BOOL "" FORCE)
set(WITH_GCRYPT OFF CACHE BOOL "" FORCE)
set(WITH_LIBSSHTUNNEL OFF CACHE BOOL "" FORCE)
set(WITH_TIGHTVNC_FILETRANSFER OFF CACHE BOOL "" FORCE)
set(WITH_SDL OFF CACHE BOOL "" FORCE)
set(WITH_GTK OFF CACHE BOOL "" FORCE)
set(WITH_QT OFF CACHE BOOL "" FORCE)
set(WITH_XCB OFF CACHE BOOL "" FORCE)
set(WITH_SYSTEMD OFF CACHE BOOL "" FORCE)
set(WITH_FFMPEG OFF CACHE BOOL "" FORCE)
set(WITH_WEBSOCKETS OFF CACHE BOOL "" FORCE)
set(WITH_SASL OFF CACHE BOOL "" FORCE)
set(WITH_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WITH_TESTS OFF CACHE BOOL "" FORCE)

add_subdirectory(avnc/libvncserver avnc/libvncserver-build EXCLUDE_FROM_ALL)

# LibVNC's included crypto backend intentionally supports only classic VNC
# authentication. macOS Screen Sharing uses Apple ARD authentication (DH,
# MD5 and AES), so replace that stub source with the Android/JNI-backed
# implementation below while keeping the rest of LibVNCClient unchanged.
get_target_property(VNC_CLIENT_SOURCES vncclient SOURCES)
if(VNC_CLIENT_SOURCES)
    list(FILTER VNC_CLIENT_SOURCES EXCLUDE REGEX "crypto_included\\.c$")
    set_property(TARGET vncclient PROPERTY SOURCES "${VNC_CLIENT_SOURCES}")
endif()
target_sources(vncclient PRIVATE android-crypto-included.c)
target_include_directories(vncclient PRIVATE
        avnc/libvncserver/include
        avnc/libvncserver/src/common)

add_library(bridge-native-vnc SHARED avnc/native-vnc.cpp)
target_include_directories(bridge-native-vnc PRIVATE
        avnc
        avnc/libvncserver/include
        avnc/libvncserver/src/libvncclient
        avnc/libvncserver/src/common
        ${CMAKE_CURRENT_BINARY_DIR}/avnc/libvncserver-build/include)
target_link_libraries(bridge-native-vnc PRIVATE vncclient log GLESv2)
set_target_properties(bridge-native-vnc PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED YES)
