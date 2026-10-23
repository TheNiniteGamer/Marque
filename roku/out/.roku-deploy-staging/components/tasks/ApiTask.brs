sub init()
    m.top.functionName = "execute"
end sub

' request: { path or url, method, body, tag, timeout }. response: { status, data, error, tag }.
sub execute()
    req = m.top.request
    url = req.url
    if url = invalid then url = m.global.server + req.path
    method = "GET"
    if req.method <> invalid and req.method <> "" then method = req.method
    timeoutMs = 20000
    if req.timeout <> invalid then timeoutMs = req.timeout

    port = CreateObject("roMessagePort")
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    xfer.SetUrl(url)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.EnableEncodings(true)
    xfer.RetainBodyOnError(true)
    xfer.AddHeader("Accept", "application/json")
    if m.global.token <> invalid and m.global.token <> "" then xfer.AddHeader("Authorization", "Bearer " + m.global.token)

    started = false
    if method = "GET" then
        started = xfer.AsyncGetToString()
    else
        body = ""
        if req.body <> invalid then
            body = FormatJson(req.body)
            xfer.AddHeader("Content-Type", "application/json")
        end if
        xfer.SetRequest(method)
        started = xfer.AsyncPostFromString(body)
    end if

    result = { status: 0, data: invalid, error: "", tag: req.tag }
    if not started then
        result.error = "Could not start the request"
        m.top.response = result
        return
    end if
    msg = wait(timeoutMs, port)
    if type(msg) = "roUrlEvent" then
        result.status = msg.GetResponseCode()
        text = msg.GetString()
        if text <> invalid and text <> "" then result.data = ParseJson(text)
        if result.status < 200 or result.status >= 300 then
            result.error = msg.GetFailureReason()
            d = result.data
            if d <> invalid and type(d) = "roAssociativeArray" and d.error <> invalid then result.error = d.error
            if result.error = invalid or result.error = "" then result.error = "The server could not be reached"
        end if
    else
        xfer.AsyncCancel()
        result.error = "The server did not answer"
    end if
    m.top.response = result
end sub
