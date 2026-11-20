#include <iostream>
#include <sstream>
#include <string>

#include "chrome/browser/ardia/ac_cli_plugin_input.h"

namespace {

ardia::PluginParam Parse(const std::string& kind, const std::string& value) {
  ardia::PluginParam param;
  if (kind == "i") {
    param.kind = ardia::PluginParam::Kind::kInt;
    param.int_value = std::stoll(value);
  } else if (kind == "d") {
    param.kind = ardia::PluginParam::Kind::kDouble;
    param.double_value = std::stod(value);
  } else if (kind == "s") {
    param.kind = ardia::PluginParam::Kind::kString;
    param.string_value = value;
  }
  return param;
}

}

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream fields(line);
    std::string which;
    std::getline(fields, which, '\t');
    ardia::PluginParams params;
    std::string field;
    while (std::getline(fields, field, '\t')) {
      const size_t equals = field.find('=');
      const size_t colon = field.find(':', equals);
      if (equals == std::string::npos || colon == std::string::npos) {
        continue;
      }
      params[field.substr(0, equals)] = Parse(field.substr(equals + 1, colon - equals - 1), field.substr(colon + 1));
    }
    std::string refusal;
    if (which == "mouse") {
      ardia::PluginMouseParams out;
      refusal = ardia::PluginMouseRefusal(params, &out);
    } else {
      ardia::PluginClickParams out;
      refusal = ardia::PluginClickRefusal(params, &out);
    }
    std::cout << (refusal.empty() ? "ok" : refusal) << "\n";
  }
  return 0;
}
