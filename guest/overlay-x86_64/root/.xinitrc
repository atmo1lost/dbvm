#!/bin/sh
# 64-bit (QEMU) session. Same as the v86 one, plus a terminal that opens before
# the window manager, so the desktop is usable even if JWM has trouble.
xrdb -merge "$HOME/.Xresources"
xsetroot -solid '#2b303b' -cursor_name left_ptr
xterm -geometry 90x24+40+40 &
exec dbus-run-session -- jwm > /var/log/jwm.log 2>&1
