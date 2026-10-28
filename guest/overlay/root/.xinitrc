#!/bin/sh
xrdb -merge "$HOME/.Xresources"
xsetroot -solid '#2b303b' -cursor_name left_ptr
exec dbus-run-session -- jwm
