# Marquee on Linux (Debian 13)

Marquee runs the same on Linux as on Windows: it's the same Docker container. On Linux,
`marquee.sh` takes the place of the `.bat` files and `marquee.ps1`, and a small system service
takes the place of the Windows scheduled task, so **Update** in Settings still works.

These steps are written for **Debian 13 (Trixie)**. They also work on Ubuntu and other
Debian-based systems with small differences. The Windows files stay in the folder and are simply
not used.

- [1. Before you wipe Windows](#1-before-you-wipe-windows)
- [2. Install Docker](#2-install-docker)
- [3. NVIDIA graphics card](#3-nvidia-graphics-card)
- [4. Your drives](#4-your-drives)
- [5. Install Marquee](#5-install-marquee)
- [6. Bring your data back](#6-bring-your-data-back)
- [7. Radarr and Sonarr](#7-radarr-and-sonarr)
- [8. Everyday use](#8-everyday-use)
- [Troubleshooting](#troubleshooting)

## 1. Before you wipe Windows

1. **Update Marquee on Windows** to the newest version (Settings → Server & updates). Backups from
   0.24.2 on also carry your uploaded opening sound.
2. **Make a backup:** Settings → Backups → **Back up now**. Copy the newest
   `marquee-backup-….tar.gz` from your backups folder (`BACKUP_DIR` in `.env`) to a USB stick or a
   drive you're keeping. It holds everyone's accounts, passwords and PINs, watch history, My List,
   requests, ratings, edits, artwork, profile pictures, the opening sound and all settings.
3. **Copy your `.env`** too. It has your folder list, TMDB key and remote-access keys
   (`TS_AUTHKEY`, `CLOUDFLARE_TUNNEL_TOKEN`).
4. **Radarr and Sonarr:** in each, *System → Backup → Backup Now*, and copy the zip files off.
5. **Converted copies:** if overnight conversions keep their copies in their own folder
   (`OPTIMIZED_DIR`), copy that folder too, or keep it on a drive you aren't wiping. Copies kept next
   to the originals travel with your media.
6. **Write down the PC's network address** (e.g. 192.168.1.20). In your router, give the PC a
   fixed address (a "DHCP reservation"), so phones, Rokus and the Shield find it at the same place
   after the move.
7. **Media drives you're keeping as they are (NTFS):** turn off Windows *Fast Startup* (Control
   Panel → Power Options → Choose what the power buttons do), then shut down. Otherwise Windows
   leaves the drives marked "in use" and Linux won't mount them for writing.

## 2. Install Docker

Use Docker's own packages (Debian's `docker.io` is older and lacks the Compose plugin Marquee uses).

```bash
sudo apt update
sudo apt install -y ca-certificates curl git gpg
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

**Log out and back in** (or restart) so the last line takes effect. Check with `docker run --rm hello-world`.
Docker starts with the PC by itself, and so does Marquee once it's been started.

## 3. NVIDIA graphics card

Skip this without one: Marquee then converts on the CPU.

**Driver.** Debian's NVIDIA driver is in its `non-free` section. Edit
`/etc/apt/sources.list.d/debian.sources` (or `/etc/apt/sources.list` on older installs) so each
`Components:` line reads `main contrib non-free non-free-firmware`, then:

```bash
sudo apt update
sudo apt install -y linux-headers-amd64 nvidia-driver firmware-misc-nonfree
sudo reboot
```

After the restart, `nvidia-smi` should list the card (an RTX 3070 shows as
"NVIDIA GeForce RTX 3070").

**Secure Boot:** if `nvidia-smi` says it can't communicate with the driver, Secure Boot is blocking
it. Either turn Secure Boot off in the PC's firmware (BIOS) settings, or enrol Debian's key:
`sudo mokutil --import /var/lib/dkms/mok.pub`, choose a one-time password, restart, and pick
*Enroll MOK* on the blue screen that appears.

**NVIDIA Container Toolkit** (lets Docker containers use the card):

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Check with `docker run --rm --gpus all debian:trixie nvidia-smi`. Then set `GPU=nvidia` in
Marquee's `.env` (step 5).

## 4. Your drives

List them with `lsblk -f`: each partition shows its type (`ntfs`, `ext4`) and a `UUID`.

Make a folder for each drive to appear in, for example:

```bash
sudo mkdir -p /mnt/media /mnt/media2
```

Then add a line for each to `/etc/fstab` (`sudo nano /etc/fstab`), using its UUID:

```fstab
# A Linux (ext4) drive
UUID=1234abcd-...  /mnt/media   ext4   defaults,nofail  0  2
# A drive kept from Windows (NTFS): files belong to you, and your group (which Marquee is in) can write
UUID=0123ABCD...   /mnt/media2  ntfs3  uid=1000,gid=1000,umask=002,nofail  0  0
```

(`1000` is your user's id: check with `id -u` and `id -g`.) `nofail` lets the PC start even if a
drive is missing. Run `sudo mount -a`, then `ls /mnt/media` to check.

**An NTFS drive won't mount, or mounts read-only:** Windows left it marked "in use". Install
`ntfs-3g` (`sudo apt install ntfs-3g`) and run `sudo ntfsfix -d /dev/sdXN` (the partition from
`lsblk`), then `sudo mount -a` again.

Moving the media onto ext4 drives later is the most trouble-free in the long run, but NTFS works.

## 5. Install Marquee

```bash
git clone https://github.com/TheNiniteGamer/marque.git ~/marquee
cd ~/marquee
./marquee.sh start
```

The first time, your settings file (`.env`) opens in `nano`. The easiest way is to paste in your
old Windows `.env` and change each folder to where it is now:

```ini
MOVIES_DIR=/mnt/media/Movies
TV_DIR=/mnt/media/TV Shows
YOUTUBE_DIR=/mnt/media/YouTube
BACKUP_DIR=/mnt/media/Marquee backups
OPTIMIZED_DIR=/mnt/media2/Marquee copies
GPU=nvidia
TZ=America/New_York
```

**Keep the numbering:** if `MOVIES_DIR_2` or `DRIVE_1` pointed at a drive on Windows, point the
same setting at that drive now (e.g. `DRIVE_1=E:/` becomes `DRIVE_1=/mnt/media2`). Folders you added
through *Settings → Libraries → Browse* are remembered by that number. Save with **Ctrl+O, Enter**
and close with **Ctrl+X**.

`marquee.sh` then:
- stops and lists any setting that's still a Windows path (`D:/…`);
- builds and starts Marquee (a few minutes the first time);
- checks that Marquee can write to its folders, and offers to fix any it can't (see
  [Folder permissions](#folder-permissions));
- offers to turn on the **update helper**, so *Update* in Settings works. Answer **Y** (it asks for
  your password once to install a system service).

Marquee is then at `http://localhost:32500` on the PC, and `http://<the PC's address>:32500`
elsewhere. It starts by itself whenever the PC starts.

## 6. Bring your data back

1. Open Marquee and create a **temporary** admin account on the first screen. The restore replaces it.
2. Copy the backup file from Windows into your backups folder (`BACKUP_DIR`).
3. **Settings → Backups**: it's listed there. Choose **Restore** on it. (Or use *Restore from a
   file…* to upload it.)
4. Sign in with your usual account. Everyone's accounts, history and settings are back; libraries
   rescan by themselves, and thumbnails and seek previews are rebuilt in the background.
5. **Sign in again on each device:** backups leave sign-ins out on purpose. Phones and browsers sign
   in as usual; Rokus and the Android TV app show a code to link again (if the PC's address changed,
   press ✱ on the Roku's sign-in screen, or *Switch server* in the Android apps, to enter the new one).
6. Copy the converted copies back into `OPTIMIZED_DIR`, if they were in their own folder.

## 7. Radarr and Sonarr

Install them on Debian with the official Servarr script (<https://wiki.servarr.com/install-script>).
When it asks which user and group to run as, give **your own user and group**, so they can move
downloads into your media folders. Restore each one from its backup zip (*System → Backup →
Restore*), then update their **root folders** to the new paths (`D:\Movies` becomes
`/mnt/media/Movies`, the same as in Marquee's `.env`).

In Marquee, *Settings → Radarr & Sonarr* keeps working with the same addresses,
`http://host.docker.internal:7878` and `:8989`.

If you'd rather run Radarr and Sonarr in Docker too, mount your media at the **same path inside
their containers as outside** (e.g. `-v /mnt/media:/mnt/media`), so the folder names they report
match Marquee's.

## 8. Everyday use

| Command (in `~/marquee`) | What it does |
| --- | --- |
| `./marquee.sh start` | Builds if needed and starts Marquee |
| `./marquee.sh stop` | Stops it. Users, libraries and watch history are kept. |
| `./marquee.sh update` | Gets the latest version, rebuilds with the newest ffmpeg and yt-dlp, and restarts |
| `./marquee.sh logs` | Shows the server log |
| `./marquee.sh check` | Checks Docker, `.env`, the graphics card set-up and folder permissions |
| `./marquee.sh install-helper` / `remove-helper` | Turns the update helper (service `marquee-updater`) on or off |
| `./marquee.sh sync-env` | Adds settings that are new in `.env.example` to your `.env` |

The update helper is a system service: `systemctl status marquee-updater` shows it, and
`journalctl -u marquee-updater` shows what it did.

Debian has no firewall switched on by default. If you add one (`ufw`), allow Marquee:
`sudo ufw allow 32500/tcp`.

## Troubleshooting

### "permission denied" talking to Docker
You aren't in the `docker` group yet: `sudo usermod -aG docker $USER`, then log out and back in.

### Folder permissions
Inside its container Marquee runs as its own user, which is also a member of **your** group. So it
can write anywhere your group can. Debian makes new folders writable by you only, so `marquee.sh`
checks each folder from `.env` and offers to fix those it can't write to, which is the same as:

```bash
chmod -R g+rwX "/mnt/media/YouTube"     # a folder you own
sudo chgrp -R $(id -gn) "/mnt/media" && sudo chmod -R g+rwX "/mnt/media"   # one you don't
```

Marquee only needs to **write** to the YouTube, backups and converted-copies folders. Your movie
and TV folders only need reading, unless you want subtitle files saved next to videos, converted
copies kept next to the originals, or disc rips organised. Run `./marquee.sh check` any time.

For NTFS drives, permissions come from the `fstab` line (`uid=…,gid=…,umask=002`), not `chmod`.

### Videos convert on the CPU, not the graphics card
*Settings → Playback → Transcoding & streaming* shows which converter is used. Check `GPU=nvidia` is in `.env`,
`nvidia-smi` works, and `docker info | grep -i nvidia` lists the NVIDIA runtime. Then run
`./marquee.sh start` again.

### Phones or TVs can't find Marquee
The PC's address probably changed: give it a fixed one in your router. On the Roku, press **✱**
on the sign-in screen to enter a different server; in the Android apps, use *Switch server* in the
account menu.
