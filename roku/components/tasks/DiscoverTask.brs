sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    found = []
    ips = CreateObject("roDeviceInfo").GetIPAddrs()
    for each name in ips
        parts = ips[name].Split(".")
        if parts.Count() = 4 then
            prefix = parts[0] + "." + parts[1] + "." + parts[2] + "."
            found.Append(scan(prefix, parts[3].ToInt()))
        end if
    end for
    m.top.found = found
end sub

function scan(prefix as String, self as Integer) as Object
    found = []
    port = CreateObject("roMessagePort")
    batch = 24
    host = 1
    while host <= 254
        pending = {}
        n = 0
        while n < batch and host <= 254
            if host <> self then
                base = "http://" + prefix + host.ToStr() + ":" + m.top.port.ToStr()
                x = CreateObject("roUrlTransfer")
                x.SetMessagePort(port)
                x.SetUrl(base + "/api/health")
                if x.AsyncGetToString() then pending[x.GetIdentity().ToStr()] = { xfer: x, base: base }
                n = n + 1
            end if
            host = host + 1
        end while
        clock = CreateObject("roTimespan")
        while pending.Count() > 0 and clock.TotalMilliseconds() < 1500
            msg = wait(150, port)
            if type(msg) = "roUrlEvent" then
                key = msg.GetSourceIdentity().ToStr()
                p = pending[key]
                if p <> invalid then
                    if msg.GetResponseCode() = 200 then
                        j = ParseJson(msg.GetString())
                        if j <> invalid and type(j) = "roAssociativeArray" and j.name = "Marquee" then
                            version = ""
                            if j.version <> invalid then version = j.version
                            found.Push({ url: p.base, name: "Marquee", version: version })
                        end if
                    end if
                    pending.Delete(key)
                end if
            end if
        end while
        for each key in pending
            pending[key].xfer.AsyncCancel()
        end for
    end while
    return found
end function
