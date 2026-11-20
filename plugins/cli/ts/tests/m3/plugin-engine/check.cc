#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "chrome/browser/ardia/ac_cli_plugin_input.h"

namespace {

std::vector<std::string> Split(const std::string& line, char separator) {
  std::vector<std::string> parts;
  std::string part;
  std::istringstream stream(line);
  while (std::getline(stream, part, separator)) {
    parts.push_back(part);
  }
  if (!line.empty() && line.back() == separator) {
    parts.push_back(std::string());
  }
  return parts;
}

std::optional<std::string> Field(const std::string& value) {
  if (value == "\x01") {
    return std::nullopt;
  }
  return value;
}

}

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    const std::vector<std::string> parts = Split(line, '\t');
    if (parts.size() != 8) {
      std::cout << "bad line\n";
      continue;
    }
    ardia::PluginKeyEvent event;
    event.type = Field(parts[0]);
    event.key = Field(parts[1]);
    event.code = Field(parts[2]);
    if (parts[3] != "\x01") {
      event.windows_key_code = std::stoi(parts[3]);
    }
    event.modifiers = std::stoi(parts[4]);
    if (!parts[5].empty()) {
      event.commands = Split(parts[5], ',');
    }
    event.has_native_key_code = parts[6] == "1";
    event.has_system_key = parts[7] == "1";
    const std::string refusal = ardia::PluginKeyRefusal(event);
    std::cout << (refusal.empty() ? "ok" : refusal) << "\n";
  }
  return 0;
}
