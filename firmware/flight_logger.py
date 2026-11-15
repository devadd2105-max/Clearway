# Clearway flight logger — BBC micro:bit V2, MicroPython
#
# Samples acceleration (+/-8 g), temperature and barometric pressure at 20 Hz and sends
# each sample over the micro:bit radio and USB serial in the Clearway packet format:
#
#     CW,<seq>,<ms>,<ax_mg>,<ay_mg>,<az_mg>,<temp_c>,<press_pa>
#
# Pressure needs an external BMP280 or BME280 breakout on the I2C pins (P19 = SCL, P20 = SDA,
# 3V and GND). Without one, pressure is sent as -1 and altitude is not available.
#
# For model rockets, high-altitude balloons and ground tests only. Mount the board on
# foam, secure the battery, and follow your rocketry association's safety code.
#
# Flash with https://python.microbit.org (V2 board). Button A: arm/disarm transmission.

from microbit import i2c, accelerometer, temperature, display, button_a, running_time, sleep, Image
import radio

RADIO_GROUP = 42      # must match ground_station.py
RATE_HZ = 20


class BMP280:
    """Minimal BMP280/BME280 temperature + pressure driver (datasheet float compensation)."""

    def __init__(self, addr):
        self.addr = addr
        c = self._read(0x88, 24)

        def u16(i):
            return c[i] | (c[i + 1] << 8)

        def s16(i):
            v = u16(i)
            return v - 65536 if v > 32767 else v

        self.T1, self.T2, self.T3 = u16(0), s16(2), s16(4)
        self.P1 = u16(6)
        self.P2, self.P3, self.P4, self.P5 = s16(8), s16(10), s16(12), s16(14)
        self.P6, self.P7, self.P8, self.P9 = s16(16), s16(18), s16(20), s16(22)
        self._write(0xF5, 0x08)  # standby 0.5 ms, IIR filter x4
        self._write(0xF4, 0x57)  # temp x2, pressure x16 oversampling, normal mode

    def _read(self, reg, n):
        i2c.write(self.addr, bytes([reg]))
        return i2c.read(self.addr, n)

    def _write(self, reg, val):
        i2c.write(self.addr, bytes([reg, val]))

    def read(self):
        d = self._read(0xF7, 6)
        adc_p = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4)
        adc_t = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4)
        v1 = (adc_t / 16384.0 - self.T1 / 1024.0) * self.T2
        v2 = ((adc_t / 131072.0 - self.T1 / 8192.0) ** 2) * self.T3
        t_fine = v1 + v2
        temp = t_fine / 5120.0
        v1 = t_fine / 2.0 - 64000.0
        v2 = v1 * v1 * self.P6 / 32768.0
        v2 = v2 + v1 * self.P5 * 2.0
        v2 = v2 / 4.0 + self.P4 * 65536.0
        v1 = (self.P3 * v1 * v1 / 524288.0 + self.P2 * v1) / 524288.0
        v1 = (1.0 + v1 / 32768.0) * self.P1
        if v1 == 0:
            return temp, -1
        p = 1048576.0 - adc_p
        p = (p - v2 / 4096.0) * 6250.0 / v1
        v1 = self.P9 * p * p / 2147483648.0
        v2 = p * self.P8 / 32768.0
        return temp, p + (v1 + v2 + self.P7) / 16.0


def find_baro():
    for addr in (0x76, 0x77):
        try:
            i2c.write(addr, bytes([0xD0]))
            if i2c.read(addr, 1)[0] in (0x58, 0x60):
                return BMP280(addr)
        except OSError:
            pass
    return None


try:
    accelerometer.set_range(8)  # default is +/-2 g, too low for powered flight
except Exception:
    pass

radio.config(group=RADIO_GROUP, length=64, power=7, data_rate=radio.RATE_1MBIT)
radio.on()

baro = find_baro()
display.show(Image.YES if baro else Image.NO)
sleep(1000)

armed = True
seq = 0
period = 1000 // RATE_HZ
display.show(Image.ARROW_N)

while True:
    start = running_time()
    if button_a.was_pressed():
        armed = not armed
        display.show(Image.ARROW_N if armed else Image.ASLEEP)
    ax, ay, az = accelerometer.get_values()
    if baro:
        temp, press = baro.read()
    else:
        temp, press = temperature(), -1
    line = "CW,%d,%d,%d,%d,%d,%.1f,%d" % (seq, start, ax, ay, az, temp, press)
    print(line)
    if armed:
        radio.send(line)
    seq += 1
    elapsed = running_time() - start
    if elapsed < period:
        sleep(period - elapsed)
