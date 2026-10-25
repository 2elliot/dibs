# Packs the image root into the app layer that push-image.ps1 appends to the Node base image.
# Entries are owned by root, files 0644 and directories 0755, sorted for a stable layer.
# usage: python -I infra/azure/make_layer.py <imageRoot> <out.tar.gz>
import sys
import tarfile
from pathlib import Path

source, out = Path(sys.argv[1]), Path(sys.argv[2])
with tarfile.open(out, "w:gz", format=tarfile.PAX_FORMAT) as archive:
    for path in sorted(source.rglob("*")):
        info = archive.gettarinfo(str(path), arcname=path.relative_to(source).as_posix())
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        info.mode = 0o755 if path.is_dir() else 0o644
        if path.is_file():
            with path.open("rb") as data:
                archive.addfile(info, data)
        else:
            archive.addfile(info)
print("layer", out.stat().st_size)
