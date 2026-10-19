sub init()
    m.status = m.top.findNode("status")
    m.list = m.top.findNode("list")
    m.found = []
    m.top.observeField("focusedChild", "onFocusChange")
    m.list.observeField("itemSelected", "onSelected")
    fillList()
    m.discover = CreateObject("roSGNode", "DiscoverTask")
    m.discover.observeField("found", "onFound")
    m.discover.control = "RUN"
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.list.setFocus(true)
end sub

sub fillList()
    root = CreateObject("roSGNode", "ContentNode")
    for each f in m.found
        n = root.createChild("ContentNode")
        n.title = "Marquee at " + f.url.Replace("http://", "")
    end for
    n = root.createChild("ContentNode")
    n.title = "Type the server's address"
    m.list.content = root
end sub

sub onFound()
    m.found = m.discover.found
    if m.found.Count() = 0 then
        m.status.text = "No Marquee server was found on this network. Type its address: it's shown on the PC running Marquee, e.g. 192.168.1.20:32500."
    else if m.found.Count() = 1 then
        m.status.text = "Found Marquee. Choose it to continue."
    else
        m.status.text = "Found " + m.found.Count().ToStr() + " Marquee servers. Choose yours."
    end if
    fillList()
end sub

sub onSelected()
    i = m.list.itemSelected
    if i < m.found.Count() then
        tryServer(m.found[i].url)
    else
        askAddress()
    end if
end sub

sub askAddress()
    d = CreateObject("roSGNode", "StandardKeyboardDialog")
    if d = invalid then d = CreateObject("roSGNode", "KeyboardDialog")
    d.title = "Server address, e.g. 192.168.1.20:32500"
    d.buttons = ["OK", "Cancel"]
    d.observeField("buttonSelected", "onAddressButton")
    m.dialog = d
    m.top.getScene().dialog = d
end sub

sub onAddressButton()
    d = m.dialog
    text = d.text
    d.close = true
    if d.buttonSelected = 0 and text <> invalid and text.Trim() <> "" then tryServer(normalizeAddress(text))
end sub

' "192.168.1.20" -> "http://192.168.1.20:32500"
function normalizeAddress(text as String) as String
    t = text.Trim()
    lower = LCase(t)
    if Left(lower, 7) <> "http://" and Left(lower, 8) <> "https://" then t = "http://" + t
    while Right(t, 1) = "/"
        t = Left(t, Len(t) - 1)
    end while
    rest = Mid(t, Instr(1, t, "://") + 3)
    if Instr(1, rest, ":") = 0 and Left(LCase(t), 7) = "http://" then t = t + ":32500"
    return t
end function

sub tryServer(url as String)
    m.trying = url
    m.status.text = "Checking " + url + " …"
    t = CreateObject("roSGNode", "ApiTask")
    t.request = { url: url + "/api/health", timeout: 6000 }
    t.observeField("response", "onHealth")
    t.control = "RUN"
    m.healthTask = t
end sub

sub onHealth(event as Object)
    r = event.getData()
    d = r.data
    if r.status = 200 and d <> invalid and type(d) = "roAssociativeArray" and d.name = "Marquee" then
        mqWrite("server", m.trying)
        m.global.server = m.trying
        m.top.navigate = { screen: "PairScreen", reset: true }
    else
        m.status.text = "No Marquee server answered at " + m.trying + ". Check the address and that the PC is on."
    end if
end sub
