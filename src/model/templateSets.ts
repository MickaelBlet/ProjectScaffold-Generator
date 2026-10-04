// Names of the template sets shipped with the app (templates/<name>), chosen per project.

export const TEMPLATE_SETS = ['cpp17', 'cpp20', 'cpp14', 'cpp11', 'cpp98', 'python', 'sca-cpp98'] as const

/** Template set of the projects choosing none. */
export const DEFAULT_TEMPLATE_SET = 'cpp17'

export const isTemplateSet = (name: string): boolean => (TEMPLATE_SETS as readonly string[]).includes(name)
