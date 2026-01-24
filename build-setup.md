# This document is a quick list of prequsites to build IYERIS for Windows, MacOS, and Linux.

## Windows
* **Version:** Windows 10 x64 or later.
* **Terminal:** Powershell 7.5.4 or later.
  * This is required due to the use of unix-like commands on windows.
* **NodeJS:** Node.js `v24.13.0` or later (LTS): [https://nodejs.org/en/download](https://nodejs.org/en/download)

---

## MacOS
* **Version:** MacOS Sonoma or later.
* **XCode Developer Tools:** `xcode-select --install`.
* **Homebrew:** [https://brew.sh](https://brew.sh).
* **Terminal:** Integrated terminal (or any 3rd party terminal) running ZSH.
* **NodeJS:** Node.js `v24.13.0` or later (LTS): [https://nodejs.org/en/download](https://nodejs.org/en/download)

---

## Linux
* **Version:** *Note: Some linux distros like debian and fedora require the use of the *:native build flag, meaning the user MUST install ruby and instal the fpm gem.* (Tested Distros)
  * Ubuntu `24.04` or later.
  * Debian `13` or later.
  * Fedora `43` or later.
* **Required** packages:
  * **Build essentials:** `build-essential` (Ubuntu/Debian) or `make`, `gcc`, `g++` (Fedora)
  * **All packages:** `RPM`, `DEB`, `DPKG`, `dpkg-dev`, `Ruby`, `GPG/GnuPG`, `flatpak-builder`, `fakeroot`, `git`
  * **Flatpak:** (configured with [Flathub](https://flathub.org/en/setup)):
  * **Required Flatpak runtimes:** `org.freedesktop.Platform`, `org.freedesktop.Sdk` (check [com.burnttoasters.iyeris.yml](com.burnttoasters.iyeris.yml) for specific versions) 
* **Terminal:** Integrated terminal (or any 3rd party terminal) running Bash or ZSH.
* **NodeJS:** Node.js `v24.13.0` or later (LTS): [https://nodejs.org/en/download](https://nodejs.org/en/download)
