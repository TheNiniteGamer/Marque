sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    m.results = []
    m.checked = 0
    prefixes = []
    ips = CreateObject("roDeviceInfo").GetIPAddrs()
    for each name in ips
        parts = ips[name].Split(".")
        if parts.Count() = 4 then prefixes.Push({ prefix: parts[0] + "." + parts[1] + "." + parts[2] + ".", self: parts[3].ToInt() })
    end for
    m.top.total = prefixes.Count() * 253
    for each p in prefixes
        scan(p.prefix, p.self)
    end for
    m.top.finished = true
end sub

sub scan(prefix as String, self as Integer)
    port = CreateObject("roMessagePort")
    batch = 32
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
                    if msg.GetResponseCode() = 200 then answered(p.base, msg.GetString())
                    pending.Delete(key)
                end if
            end if
        end while
        for each key in pending
            pending[key].xfer.AsyncCancel()
        end for
        m.checked = m.checked + n
        m.top.checked = m.checked
    end while
end sub

' A Marquee server answered: add it to the list straight away.
sub answered(base as String, body as String)
    j = ParseJson(body)
    if j = invalid or type(j) <> "roAssociativeArray" or j.name <> "Marquee" then return
    version = ""
    if type(j.version) = "roString" or type(j.version) = "String" then version = j.version
    server = ""
    if type(j.server) = "roString" or type(j.server) = "String" then server = j.server
    m.results.Push({ url: base, name: "Marquee", version: version, server: server })
    m.top.found = m.results
end sub
