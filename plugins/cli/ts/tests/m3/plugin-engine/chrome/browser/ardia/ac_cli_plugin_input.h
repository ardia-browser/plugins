// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_INPUT_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_INPUT_H_

#include <optional>
#include <string>
#include <vector>

namespace ardia {

inline constexpr int kCdpAlt = 1;
inline constexpr int kCdpCtrl = 2;
inline constexpr int kCdpMeta = 4;
inline constexpr int kCdpShift = 8;
inline constexpr int kCdpMiddleButton = 4;

struct PluginKeyEvent {
  std::optional<std::string> type;
  std::optional<int> windows_key_code;
  bool has_native_key_code = false;
  bool has_system_key = false;
  std::optional<int> modifiers;
  std::optional<std::string> key;
  std::optional<std::string> code;
  bool commands_valid = true;
  std::vector<std::string> commands;
};

std::string PluginKeyRefusal(const PluginKeyEvent& event);

std::string PluginMouseRefusal(const std::optional<std::string>& button,
                               std::optional<int> buttons);

}

#endif
