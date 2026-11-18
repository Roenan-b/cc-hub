@{
    Severity     = @('Error', 'Warning')
    ExcludeRules = @(
        # Installers print progress for a person watching the console.
        'PSAvoidUsingWriteHost',
        # Bootstrap helpers are internal script functions, not exported cmdlets.
        'PSUseShouldProcessForStateChangingFunctions',
        'PSUseSingularNouns'
    )
}
