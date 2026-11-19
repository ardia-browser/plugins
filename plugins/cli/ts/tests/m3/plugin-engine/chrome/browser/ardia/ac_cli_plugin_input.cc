// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_plugin_input.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>

#include "chrome/browser/ardia/ac_cli_plugin_clipboard_keys.h"
#include "chrome/browser/ardia/ac_cli_plugin_key_table.h"

namespace ardia {
namespace {

constexpr std::string_view kModifierKeys[] = {
    "Shift", "Control", "Alt", "Meta", "CapsLock",
};

constexpr std::string_view kNavigationKeys[] = {
    "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
    "Home",      "End",     "PageUp",     "PageDown",
};

constexpr std::string_view kCommandEventTypes[] = {"keyDown", "rawKeyDown"};

constexpr std::string_view kEditingCommands[] = {
    "deletebackward",
    "deleteforward",
    "deletewordbackward",
    "deletewordforward",
    "insertnewline",
    "inserttab",
    "movedown",
    "movedownandmodifyselection",
    "moveleft",
    "moveleftandmodifyselection",
    "moveright",
    "moverightandmodifyselection",
    "movetobeginningofdocument",
    "movetobeginningofdocumentandmodifyselection",
    "movetobeginningofline",
    "movetobeginningoflineandmodifyselection",
    "movetoendofdocument",
    "movetoendofdocumentandmodifyselection",
    "movetoendofline",
    "movetoendoflineandmodifyselection",
    "moveup",
    "moveupandmodifyselection",
    "movewordleft",
    "movewordleftandmodifyselection",
    "movewordright",
    "movewordrightandmodifyselection",
    "selectall",
};

template <size_t N>
bool Contains(const std::string_view (&list)[N], std::string_view value) {
  return std::find(std::begin(list), std::end(list), value) != std::end(list);
}

std::string Lower(std::string text) {
  for (char& c : text) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return text;
}

bool IsModifierKey(const std::string& key) {
  return Contains(kModifierKeys, key);
}

bool RowHasKey(const PluginKeyRow& row, const std::string& key) {
  return key == row.base || key == row.shifted || key == row.named;
}

bool GenericModifierCode(const PluginKeyRow& row, int code) {
  const std::string_view named = row.named;
  return (named == "Shift" && code == 16) ||
         (named == "Control" && code == 17) ||
         (named == "Alt" && code == 18) ||
         (named == "Meta" && (code == 91 || code == 92 || code == 93));
}

bool RowFitsCode(const PluginKeyRow& row, int code) {
  return row.windows_key_code == code || GenericModifierCode(row, code);
}

std::string AgreementRefusal(const PluginKeyEvent& event, int code) {
  const std::string& key = *event.key;
  if (key.empty()) {
    return "with an empty key";
  }
  bool key_known = false;
  for (const PluginKeyRow& row : kPluginKeyRows) {
    if (!RowHasKey(row, key)) {
      continue;
    }
    key_known = true;
    if (event.code && *event.code != row.code) {
      continue;
    }
    if (!event.windows_key_code || RowFitsCode(row, code)) {
      return std::string();
    }
  }
  if (key_known) {
    return event.code ? "with a code or key code that doesn't match its key"
                      : "with a key code that doesn't match its key";
  }
  if (event.code || code) {
    return "with a code or key code for a key the layout doesn't know";
  }
  return std::string();
}

std::string ModifierRefusal(const std::string& key, int modifiers) {
  const bool shift = modifiers & kCdpShift;
  const int others = modifiers & (kCdpAlt | kCdpCtrl | kCdpMeta);
  if (IsModifierKey(key)) {
    return std::string();
  }
  if (!others) {
    if (shift && (key == "Insert" || key == "Delete")) {
      return "with Shift on Insert or Delete";
    }
    return std::string();
  }
  if (Contains(kNavigationKeys, key)) {
    return std::string();
  }
  if ((key == "a" || key == "A") && !shift && !(others & kCdpAlt)) {
    return std::string();
  }
#if defined(_WIN32)
  if (key == "Backspace" && (others & kCdpAlt)) {
    return "with Alt on Backspace, which undoes on Windows";
  }
#endif
  if ((key == "Backspace" || key == "Delete") && !shift) {
    return std::string();
  }
  return "with a modifier that isn't for moving, selecting or deleting";
}

bool IsClipboardKey(int code, int modifiers, const std::string& key) {
  for (const PluginClipboardKey& entry : kPluginClipboardKeys) {
    if (entry.modifiers != modifiers) {
      continue;
    }
    if (entry.dom_key[0] ? key == entry.dom_key
                         : code == entry.windows_key_code) {
      return true;
    }
  }
  return false;
}

std::string CommandsRefusal(const PluginKeyEvent& event) {
  if (!event.commands_valid) {
    return "with those editing commands";
  }
  if (event.commands.empty()) {
    return std::string();
  }
  if (!event.type || !Contains(kCommandEventTypes, *event.type)) {
    return "with editing commands on that event type";
  }
  for (const std::string& command : event.commands) {
    if (!Contains(kEditingCommands, Lower(command))) {
      return "with that editing command";
    }
  }
  return std::string();
}

}

std::string PluginKeyRefusal(const PluginKeyEvent& event) {
  if (event.has_native_key_code || event.has_system_key) {
    return "with a native key code or a system key";
  }
  const int modifiers = event.modifiers.value_or(0);
  if (modifiers & ~(kCdpAlt | kCdpCtrl | kCdpMeta | kCdpShift)) {
    return "with unknown modifier bits";
  }
  const int code = event.windows_key_code.value_or(0);
  if (code < 0 || code > 255) {
    return "with a key code outside 0-255";
  }
  std::string refusal = CommandsRefusal(event);
  if (!refusal.empty()) {
    return refusal;
  }
  if (!event.key) {
    return code || event.code ? "with a key code or code but no key"
                              : std::string();
  }
  const std::string& key = *event.key;
  if (key == "Copy" || key == "Cut" || key == "Paste") {
    return "with a key that cuts, copies or pastes";
  }
  refusal = AgreementRefusal(event, code);
  if (refusal.empty()) {
    refusal = ModifierRefusal(key, modifiers);
  }
  if (refusal.empty() && IsClipboardKey(code, modifiers, key)) {
    refusal = "with a key that cuts, copies or pastes";
  }
  return refusal;
}

std::string PluginMouseRefusal(const std::optional<std::string>& button,
                               std::optional<int> buttons) {
  if (button && *button == "middle") {
    return "with the middle button";
  }
  if (buttons && (*buttons & kCdpMiddleButton)) {
    return "with the middle button held";
  }
  return std::string();
}

}
