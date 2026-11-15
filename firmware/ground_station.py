# Clearway ground station — BBC micro:bit (V1 or V2), MicroPython
#
# Receives packets from flight_logger.py over the micro:bit radio and forwards them to
# the Clearway Telemetry tab over USB serial (115200 baud), appending the signal strength:
#
#     CW,<seq>,<ms>,<ax_mg>,<ay_mg>,<az_mg>,<temp_c>,<press_pa>,<rssi_dbm>
#
# Plug this board into the laptop, open Clearway in Chrome or Edge, Telemetry tab,
# "Connect micro:bit", and pick this board's serial port.

from microbit import display, Image, running_time
import radio

RADIO_GROUP = 42  # must match flight_logger.py

radio.config(group=RADIO_GROUP, length=64, data_rate=radio.RATE_1MBIT)
radio.on()
display.show(Image.SQUARE_SMALL)

last = running_time()
while True:
    pkt = radio.receive_full()
    if pkt:
        msg, rssi, _ = pkt
        try:
            line = str(msg[3:], "utf8")  # strings sent with radio.send() carry a 3-byte header
        except Exception:
            continue
        if line.startswith("CW,"):
            print(line + "," + str(rssi))
            display.set_pixel(2, 2, 9)
            last = running_time()
    elif running_time() - last > 1000:
        display.set_pixel(2, 2, 0)  # centre LED goes dark when the link drops
