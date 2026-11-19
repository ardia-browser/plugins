#[used]
#[cfg_attr(target_os = "macos", link_section = "__DATA,__mod_init_func")]
#[cfg_attr(not(target_os = "macos"), link_section = ".init_array")]
static NOTE_STANDARD_FDS: extern "C" fn() = ardia::standard_fds::note;

fn main() {
    std::process::exit(ardia::run());
}
