/* =====================================================================
   CellScope — motorised microscope stage firmware
   Protocol (newline-terminated ASCII, one reply per command):
     G X <steps>   move X by signed steps      -> "OK"
     G Y <steps>   move Y by signed steps      -> "OK"
     Z             zero the position counters  -> "OK"
     ?             query                       -> "OK X:<n> Y:<n>"
   Deliberately trivial: the phone does the thinking, the microcontroller
   only makes steps happen with correct timing. Linux on the Pi cannot be
   trusted to bit-bang smooth step pulses; a microcontroller can.

   BUILD A — ESP32 (recommended: BLE is built in, ~$5, no Pi needed)
     Board: ESP32 Dev Module. Uses BLE Nordic UART Service.
   BUILD B — Arduino Nano/Uno + HM-10 BLE module, or plain USB serial to a Pi
     Comment out USE_BLE below; the same commands arrive over Serial.

   Wiring (both builds), A4988/DRV8825 drivers:
     X: STEP->D26  DIR->D25      Y: STEP->D33  DIR->D32      EN->D27 (both, active low)
     Motor supply 12V to VMOT with a 100uF cap across VMOT/GND. Set the
     driver current limit before connecting motors, or you will cook them.
   ===================================================================== */

#define USE_BLE 1          // 0 = plain Serial (Arduino + Pi over USB)

#if USE_BLE
  #include <BLEDevice.h>
  #include <BLEServer.h>
  #include <BLEUtils.h>
  #include <BLE2902.h>
  #define SVC_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
  #define RX_UUID  "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
  #define TX_UUID  "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
  BLECharacteristic *pTx;
  bool connected = false;
#endif

const int X_STEP = 26, X_DIR = 25, Y_STEP = 33, Y_DIR = 32, EN = 27;
const unsigned int STEP_US = 900;      // pulse period; raise if motors stall
long posX = 0, posY = 0;
String line = "";

void reply(const String &s) {
#if USE_BLE
  String out = s + "\n";
  pTx->setValue((uint8_t*)out.c_str(), out.length());
  pTx->notify();
#else
  Serial.println(s);
#endif
}

void stepAxis(int stepPin, int dirPin, long steps, long &pos) {
  digitalWrite(EN, LOW);                       // enable drivers
  digitalWrite(dirPin, steps >= 0 ? HIGH : LOW);
  long n = labs(steps);
  for (long i = 0; i < n; i++) {
    digitalWrite(stepPin, HIGH); delayMicroseconds(STEP_US / 2);
    digitalWrite(stepPin, LOW);  delayMicroseconds(STEP_US / 2);
  }
  pos += steps;
  digitalWrite(EN, HIGH);                      // release: motors cool, stage holds by friction
}

void handle(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;
  if (cmd == "?")      { reply("OK X:" + String(posX) + " Y:" + String(posY)); return; }
  if (cmd == "Z")      { posX = posY = 0; reply("OK"); return; }
  if (cmd.startsWith("G ")) {
    char axis = cmd.charAt(2);
    long steps = cmd.substring(4).toInt();
    if (labs(steps) > 200000) { reply("ERR range"); return; }   // refuse to drive off the stage
    if (axis == 'X')      stepAxis(X_STEP, X_DIR, steps, posX);
    else if (axis == 'Y') stepAxis(Y_STEP, Y_DIR, steps, posY);
    else { reply("ERR axis"); return; }
    reply("OK");
    return;
  }
  reply("ERR cmd");
}

#if USE_BLE
class SrvCB : public BLEServerCallbacks {
  void onConnect(BLEServer*) { connected = true; }
  void onDisconnect(BLEServer* s) { connected = false; s->startAdvertising(); }
};
class RxCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) {
    String v = String(c->getValue().c_str());
    for (unsigned int i = 0; i < v.length(); i++) {
      char ch = v[i];
      if (ch == '\n') { handle(line); line = ""; }
      else line += ch;
    }
  }
};
#endif

void setup() {
  pinMode(X_STEP, OUTPUT); pinMode(X_DIR, OUTPUT);
  pinMode(Y_STEP, OUTPUT); pinMode(Y_DIR, OUTPUT);
  pinMode(EN, OUTPUT); digitalWrite(EN, HIGH);
  Serial.begin(115200);
#if USE_BLE
  BLEDevice::init("CellScope");
  BLEServer *srv = BLEDevice::createServer();
  srv->setCallbacks(new SrvCB());
  BLEService *svc = srv->createService(SVC_UUID);
  pTx = svc->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pTx->addDescriptor(new BLE2902());
  BLECharacteristic *pRx = svc->createCharacteristic(RX_UUID, BLECharacteristic::PROPERTY_WRITE |
                                                              BLECharacteristic::PROPERTY_WRITE_NR);
  pRx->setCallbacks(new RxCB());
  svc->start();
  srv->getAdvertising()->addServiceUUID(SVC_UUID);
  srv->getAdvertising()->start();
#endif
}

void loop() {
#if !USE_BLE
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n') { handle(line); line = ""; }
    else line += ch;
  }
#endif
  delay(5);
}
