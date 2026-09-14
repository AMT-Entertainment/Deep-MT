// inputctl — tiny CGEvent input controller for DeepMT TAKE OVER.
// Compile: swiftc -O -framework ApplicationServices -o inputctl inputctl.swift
// Usage:
//   inputctl check
//   inputctl click <x> <y>
//   inputctl scroll <ticks>
//   inputctl type "some text"
//   inputctl key <enter|tab|esc|space|up|down|left|right|a..z|cmd+space|...>
import Foundation
import CoreGraphics
import ApplicationServices

let args = CommandLine.arguments

func post(_ down: CGEvent, _ up: CGEvent) {
    down.post(tap: .cghidEventTap)
    usleep(30000)
    up.post(tap: .cghidEventTap)
}

func currentPos() -> CGPoint {
    return CGEvent(source: nil)?.location ?? CGPoint(x: 0, y: 0)
}

// Visible cursor travel — the user sees the pointer glide to the target.
func glide(to pt: CGPoint) {
    let from = currentPos()
    let steps = 14
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let eased = t * t * (3 - 2 * t) // smoothstep
        let p = CGPoint(x: from.x + (pt.x - from.x) * eased,
                        y: from.y + (pt.y - from.y) * eased)
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(16000)
    }
}

func click(_ x: CGFloat, _ y: CGFloat) {
    let pt = CGPoint(x: x, y: y)
    glide(to: pt)
    usleep(90000)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(90000)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func scroll(_ ticks: Int) {
    let sc = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(ticks), wheel2: 0, wheel3: 0)
    sc?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "tab": 48, "esc": 53, "escape": 53,
    "space": 49, "up": 126, "down": 125, "left": 123, "right": 124,
    "delete": 51, "backspace": 51,
]

// QWERTY keycodes (Carbon). Lowercase letters / digits / punctuation.
let asciiKeyCode: [Int32: CGKeyCode] = {
    var m: [Int32: CGKeyCode] = [:]
    let table: [Character: CGKeyCode] = [
        "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,
        "1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,
        "i":34,"p":35,"l":37,"j":38,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47," ":49
    ]
    for (c, code) in table {
        if let v = c.asciiValue { m[Int32(v)] = code }
    }
    m[32] = 49  // space
    m[61] = 24  // '='
    m[0x2A] = 42 // '*'
    m[0x24] = 37 // '$'
    return m
}()

func type(_ text: String) {
    for ch in text.unicodeScalars {
        guard let code = asciiKeyCode[Int32(ch.value)] else { continue }
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        post(down!, up!)
        usleep(12000)
    }
}

func keyCombo(_ raw: String) -> Bool {
    var flags: CGEventFlags = []
    var keyName = ""
    for part in raw.split(separator: "+").map(String.init) {
        switch part.lowercased() {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "option", "alt": flags.insert(.maskAlternate)
        case "control", "ctrl": flags.insert(.maskControl)
        case "shift": flags.insert(.maskShift)
        default: keyName = part
        }
    }
    guard !keyName.isEmpty else { return false }
    let kn = keyName.lowercased()
    if let code = keyCodes[kn] {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
        down.flags = flags
        up.flags = flags
        post(down, up)
        return true
    }
    if let v = kn.first, kn.count == 1, let code = asciiKeyCode[Int32(v.asciiValue!)] {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
        down.flags = flags
        up.flags = flags
        post(down, up)
        return true
    }
    return false
}

func main() -> Int32 {
    guard args.count >= 2 else {
        print("usage: inputctl check | click <x> <y> | scroll <ticks> | type <text> | key <name>")
        return 1
    }
    let cmd = args[1]
    if cmd == "check" {
        if AXIsProcessTrusted() {
            print("trusted")
            return 0
        }
        print("NOT_TRUSTED — grant Accessibility to the app that launched me")
        return 3
    }
    guard AXIsProcessTrusted() else {
        print("inputctl: NOT_TRUSTED — grant Accessibility (System Settings > Privacy & Security > Accessibility) and restart.")
        return 3
    }
    switch cmd {
    case "click":
        guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { return 1 }
        click(CGFloat(x), CGFloat(y))
    case "scroll":
        guard args.count >= 3, let t = Int(args[2]) else { return 1 }
        scroll(t)
    case "type":
        guard args.count >= 3 else { return 1 }
        type(args[2])
    case "key":
        guard args.count >= 3 else { return 1 }
        return keyCombo(args[2]) ? 0 : 1
    default:
        print("usage: inputctl <input>")
        return 1
    }
    return 0
}

exit(main())