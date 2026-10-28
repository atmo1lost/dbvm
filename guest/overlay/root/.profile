export PS1='\u@\h:\w\$ '

# The VGA console (tty1) becomes the desktop. Touch /etc/dbvm/no-x to opt out.
if [ "$(tty)" = /dev/tty1 ] && [ -z "$DISPLAY" ] && [ ! -e /etc/dbvm/no-x ]; then
	exec startx -- -nolisten tcp vt1 > /var/log/startx.log 2>&1
fi
